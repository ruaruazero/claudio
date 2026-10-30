import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Fault, Store } from "./store.js";
import type { AgentEvent } from "../src/protocol.js";
import { createParser } from "eventsource-parser";
import { Readable } from "node:stream";
import type { SpeechAck } from "../src/protocol.js";
import { serviceIssue } from "./incidents.js";
import { isInternalReply } from "../src/model-output.js";

export interface SpeechProvider {
  synthesize(text: string, signal: AbortSignal): Promise<{ bytes: Buffer; contentType: string }>;
  stream?(text: string, signal: AbortSignal): AsyncIterable<Buffer>;
}
export const SPEECH_SAMPLE_RATE = 24000;

export function spokenText(text: string) {
  if (isInternalReply(text)) return "";
  return text.replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/[*_`~]/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

const audioResponse = z.object({ choices: z.array(z.object({
  finish_reason: z.string().nullish(),
  message: z.object({ audio: z.object({ data: z.string().min(1).max(12_000_000) }) }),
})).min(1) });

export class MimoSpeech implements SpeechProvider {
  constructor(private key: string, private model = "mimo-v2.5-tts",
    private voice = "mimo_default", private base = "https://api.xiaomimimo.com/v1") {}

  private async request(text: string, signal: AbortSignal, streaming: boolean) {
    const response = await fetch(`${this.base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", "api-key": this.key },
      body: JSON.stringify({
        model: this.model, stream: streaming,
        messages: [
          { role: "user", content: "像深夜电台主播一样自然、温和地说话，语速适中，避免播报腔。只朗读提供的文字，不增删内容。" },
          { role: "assistant", content: text },
        ],
        audio: { format: streaming ? "pcm16" : "wav", voice: this.voice },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Fault(response.status === 401 ? "TTS_AUTH_FAILED" :
        response.status === 402 ? "TTS_BALANCE" : response.status === 403 ? "TTS_PERMISSION_DENIED" :
        response.status === 404 ? "TTS_CONFIGURATION" :
        response.status === 429 ? "TTS_RATE_LIMITED" : "TTS_PROVIDER_FAILED", 502);
    }
    return response;
  }
  async *stream(text: string, signal: AbortSignal): AsyncIterable<Buffer> {
    const response = await this.request(text, signal, true);
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      await response.body?.cancel();
      throw new Fault("TTS_INVALID_STREAM");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Fault("TTS_EMPTY_AUDIO");
    const decoder = new TextDecoder();
    const queue: Buffer[] = [];
    let done = false, finished = false, size = 0, wireSize = 0, pendingSize = 0, carry = Buffer.alloc(0);
    const parser = createParser({ onError() { throw new Fault("TTS_INVALID_STREAM"); }, onEvent(event) {
      pendingSize = 0;
      if (event.data === "[DONE]") { done = true; return; }
      if (done) throw new Fault("TTS_INVALID_STREAM");
      const chunk = z.object({ choices: z.array(z.object({
        finish_reason: z.string().nullish(),
        delta: z.object({ audio: z.object({ data: z.string().max(2_000_000).nullish() }).nullish() }).optional(),
      })) }).safeParse(JSON.parse(event.data));
      if (!chunk.success) throw new Fault("TTS_INVALID_STREAM");
      const choice = chunk.data.choices[0];
      if (choice?.finish_reason === "stop") finished = true;
      else if (choice?.finish_reason) throw new Fault("TTS_INCOMPLETE_AUDIO");
      const encoded = choice?.delta?.audio?.data;
      if (!encoded) return;
      if (encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Fault("TTS_INVALID_AUDIO");
      const pcm = Buffer.concat([carry, Buffer.from(encoded, "base64")]);
      const even = pcm.length - pcm.length % 2;
      carry = pcm.subarray(even);
      size += even;
      if (size > 9_000_000) throw new Fault("TTS_RESPONSE_TOO_LARGE");
      if (even) queue.push(pcm.subarray(0, even));
    } });
    try {
      for (;;) {
        signal.throwIfAborted();
        const item = await reader.read();
        if (item.done) break;
        wireSize += item.value.length;
        pendingSize += item.value.length;
        if (wireSize > 16_000_000 || pendingSize > 2_000_000) throw new Fault("TTS_RESPONSE_TOO_LARGE");
        parser.feed(decoder.decode(item.value, { stream: true }));
        while (queue.length) yield queue.shift()!;
        if (done) break;
      }
      parser.feed(decoder.decode());
      while (queue.length) yield queue.shift()!;
      if (!finished || !size || carry.length) throw new Fault("TTS_INCOMPLETE_AUDIO");
    } finally { await reader.cancel().catch(() => {}); }
  }
  async synthesize(text: string, signal: AbortSignal) {
    const response = await this.request(text, signal, false);
    const reader = response.body?.getReader();
    if (!reader) throw new Fault("TTS_EMPTY_AUDIO");
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 12_100_000) throw new Fault("TTS_RESPONSE_TOO_LARGE");
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    const parsed = audioResponse.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success || ["length", "content_filter"].includes(parsed.data.choices[0].finish_reason ?? "")) {
      throw new Fault("TTS_INVALID_AUDIO");
    }
    const data = parsed.data.choices[0].message.audio.data;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Fault("TTS_INVALID_AUDIO");
    const bytes = Buffer.from(data, "base64");
    if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WAVE") throw new Fault("TTS_INVALID_AUDIO");
    return { bytes, contentType: "audio/wav" };
  }
}

type SpeechAsset = {
  sessionId: string; bytes: Buffer; contentType: string; expiresAt: number;
  chunks?: Buffer[]; size: number; done: boolean; error?: Error;
  wake: Set<() => void>;
};
type SpeechItem = { messageId: string; text: string; proactive: boolean; requestId?: string; manual?: boolean };
export class SpeechService {
  private subscriptions = new Map<string, () => void>();
  private jobs = new Map<string, { id: string; controller: AbortController; promise: Promise<void> }>();
  private pending = new Set<Promise<void>>();
  private cancelledThrough = new Map<string, number>();
  private assets = new Map<string, SpeechAsset>();
  private lastSpeech = new Map<string, string>();
  private proactiveSpeech = new Set<string>();
  private speechQueues = new Map<string, SpeechItem[]>();
  private activeSpeech = new Map<string, { id: string; requestId?: string; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  constructor(private store: Store, public provider: SpeechProvider | null) {}
  watch(sessionId: string) {
    if (this.closed || this.subscriptions.has(sessionId)) return;
    this.subscriptions.set(sessionId, this.store.subscribe(sessionId, (event) => {
      queueMicrotask(() => { if (!this.closed) this.onEvent(event); });
    }));
  }
  private onEvent(event: AgentEvent) {
    if (this.proactiveSpeech.has(event.sessionId) &&
      ["queue.updated", "playback.command", "playback.observed"].includes(event.type)) {
      const state = this.store.read(event.sessionId);
      if (state.desiredPlayback !== "play" ||
        ["paused", "blocked", "failed"].includes(state.playbackAck?.status ?? "")) {
        this.cancel(event.sessionId, event.sequence);
        return;
      }
    }
    if (event.type === "message.saved" || (event.type === "settings.updated" && !event.payload.autoSpeech)) {
      this.cancel(event.sessionId, event.sequence);
    } else if (event.type === "reply.final" && event.payload.source === "model" &&
      event.sequence > (this.cancelledThrough.get(event.sessionId) ?? 0) &&
      this.store.read(event.sessionId).settings.autoSpeech && this.provider) {
      const state = this.store.read(event.sessionId);
      if (event.payload.proactive &&
        (state.desiredPlayback !== "play" || state.playbackAck?.status !== "playing")) return;
      const item = { messageId: event.payload.id, text: event.payload.text,
        proactive: Boolean(event.payload.proactive), requestId: event.requestId ?? event.payload.requestId };
      if (!spokenText(item.text)) return;
      const active = this.activeSpeech.get(event.sessionId);
      if (active && active.requestId && active.requestId === item.requestId) {
        const queue = this.speechQueues.get(event.sessionId) ?? [];
        if (queue.length < 3 && !queue.some((queued) => queued.messageId === item.messageId)) queue.push(item);
        this.speechQueues.set(event.sessionId, queue);
      } else {
        this.cancel(event.sessionId, event.sequence - 1);
        this.start(event.sessionId, item);
      }
    }
  }
  replay(sessionId: string, messageId: string) {
    if (!this.provider) throw new Fault("TTS_NOT_CONFIGURED", 503);
    const message = this.store.read(sessionId).messages.find(message => message.id === messageId);
    if (!message || message.role !== "assistant" || message.source !== "model" || !spokenText(message.text)) {
      throw new Fault("SPEECH_MESSAGE_NOT_FOUND", 404);
    }
    this.cancel(sessionId);
    this.start(sessionId, { messageId, text: message.text, proactive: false, manual: true });
  }
  private start(sessionId: string, { messageId, text, proactive, requestId, manual }: SpeechItem) {
    if (proactive) this.proactiveSpeech.add(sessionId);
    const clean = spokenText(text);
    if (!clean) return;
    const id = randomUUID();
    const timer = setTimeout(() => { if (this.activeSpeech.get(sessionId)?.id === id) this.cancel(sessionId); }, 120_000);
    timer.unref();
    this.activeSpeech.set(sessionId, { id, requestId, timer });
    const controller = new AbortController();
    const started = Date.now();
    this.lastSpeech.set(sessionId, id);
    this.store.change(sessionId, (state, emit) => {
      state.speechAck = null;
      emit({ type: "speech.synthesizing", payload: { speechId: id, messageId, ...(manual ? { manual } : {}) } });
    });
    // Defer to let the originating transaction finish delivering its events.
    const promise = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted();
        if (clean.length > 2000) throw new Fault("TTS_TEXT_TOO_LONG");
        if (this.provider!.stream) {
          let asset: SpeechAsset | undefined;
          let count = 0;
          for await (const bytes of this.provider!.stream(clean, controller.signal)) {
            controller.signal.throwIfAborted();
            if (this.closed || this.jobs.get(sessionId)?.id !== id ||
              (!manual && !this.store.read(sessionId).settings.autoSpeech)) return;
            if (!bytes.length) continue;
            if (bytes.length % 2) throw new Fault("TTS_INVALID_PCM");
            if (!asset) {
              this.prune();
              asset = { sessionId, bytes: Buffer.alloc(0), contentType: "application/octet-stream",
                expiresAt: Date.now() + 300_000, chunks: [], size: 0, done: false, wake: new Set() };
              this.assets.set(id, asset);
            }
            if (asset.size + bytes.length > 9_000_000 || this.totalSize() + bytes.length > 32_000_000) {
              throw new Fault("TTS_RESPONSE_TOO_LARGE");
            }
            asset.chunks!.push(bytes);
            asset.size += bytes.length;
            this.wake(asset);
            if (++count === 1) this.store.change(sessionId, (_, emit) => emit({ type: "speech.ready",
              payload: { speechId: id, messageId, ...(manual ? { manual } : {}), url: `/api/lab/speech/${id}`, format: "pcm16",
                sampleRate: SPEECH_SAMPLE_RATE, firstAudioMs: Date.now() - started,
                expiresAt: new Date(asset!.expiresAt).toISOString() } }));
          }
          controller.signal.throwIfAborted();
          if (this.closed || this.jobs.get(sessionId)?.id !== id) return;
          if (!asset) throw new Fault("TTS_EMPTY_AUDIO");
          asset.done = true;
          this.wake(asset);
          this.store.updateServiceIssue(sessionId, "speech", null);
          this.store.change(sessionId, (_, emit) => emit({ type: "speech.completed",
            payload: { speechId: id, messageId, durationMs: Date.now() - started, chunks: count, bytes: asset!.size } }));
          return;
        }
        const result = await this.provider!.synthesize(clean, controller.signal);
        controller.signal.throwIfAborted();
        if (this.closed || this.jobs.get(sessionId)?.id !== id ||
          (!manual && !this.store.read(sessionId).settings.autoSpeech)) return;
        this.prune();
        if (result.bytes.length > 9_000_000) throw new Fault("TTS_RESPONSE_TOO_LARGE");
        if (this.totalSize() + result.bytes.length > 32_000_000) throw new Fault("TTS_RESPONSE_TOO_LARGE");
        const expiresAt = Date.now() + 300_000;
        this.assets.set(id, { ...result, sessionId, expiresAt, size: result.bytes.length, done: true, wake: new Set() });
        this.store.updateServiceIssue(sessionId, "speech", null);
        this.store.change(sessionId, (_, emit) => emit({ type: "speech.ready",
          payload: { speechId: id, messageId, ...(manual ? { manual } : {}), url: `/api/lab/speech/${id}`, expiresAt: new Date(expiresAt).toISOString() } }));
      } catch (error) {
        const asset = this.assets.get(id);
        if (asset) { asset.error = new Error("TTS_STREAM_FAILED"); asset.done = true; this.wake(asset); }
        if (!controller.signal.aborted && !this.closed) {
          const code = error instanceof Fault ? error.code : "TTS_NETWORK_OR_TIMEOUT";
          const issue = serviceIssue("speech", code);
          if (issue) this.store.updateServiceIssue(sessionId, "speech", issue);
          this.store.change(sessionId, (_, emit) =>
            emit({ type: "speech.failed", payload: { messageId, speechId: id, code } }));
          this.speechQueues.delete(sessionId);
          const active = this.activeSpeech.get(sessionId);
          if (active?.id === id) { clearTimeout(active.timer); this.activeSpeech.delete(sessionId); }
        }
      } finally {
        if (this.jobs.get(sessionId)?.id === id) this.jobs.delete(sessionId);
      }
    });
    this.jobs.set(sessionId, { id, controller, promise });
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }
  cancel(sessionId: string, through = this.store.read(sessionId).lastSequence) {
    const active = this.activeSpeech.get(sessionId);
    if (active) clearTimeout(active.timer);
    this.activeSpeech.delete(sessionId);
    this.speechQueues.delete(sessionId);
    this.proactiveSpeech.delete(sessionId);
    this.cancelledThrough.set(sessionId, through);
    const job = this.jobs.get(sessionId);
    job?.controller.abort();
    this.jobs.delete(sessionId);
    for (const [id, asset] of this.assets) if (asset.sessionId === sessionId) this.remove(id, asset);
    this.store.change(sessionId, (state, emit) => {
      if (state.speechAck?.status === "playing") state.speechAck = null;
      emit({ type: "speech.cancelled", payload: {} });
    });
  }
  private totalSize() { return [...this.assets.values()].reduce((sum, item) => sum + item.size, 0); }
  private wake(asset: SpeechAsset) { for (const wake of asset.wake) wake(); asset.wake.clear(); }
  private remove(id: string, asset: SpeechAsset) {
    if (!asset.done) asset.error = new Error("TTS_CANCELLED");
    asset.done = true;
    this.wake(asset);
    this.assets.delete(id);
  }
  private prune() {
    for (const [id, asset] of this.assets) if (asset.expiresAt <= Date.now()) this.remove(id, asset);
  }
  get(id: string) {
    this.prune();
    const asset = this.assets.get(id);
    if (!asset) throw new Fault("SPEECH_EXPIRED", 404);
    return asset;
  }
  open(id: string) {
    const asset = this.get(id);
    if (!asset.chunks) return { contentType: asset.contentType, body: asset.bytes };
    let body!: Readable;
    body = Readable.from((async function* () {
      let index = 0;
      while (true) {
        if (asset.error) throw asset.error;
        if (index < asset.chunks!.length) { yield asset.chunks![index++]; continue; }
        if (asset.done) return;
        await new Promise<void>((resolve) => {
          const wake = () => { asset.wake.delete(wake); body.off("close", wake); resolve(); };
          asset.wake.add(wake);
          body.once("close", wake);
        });
        if (body.destroyed) return;
      }
    })());
    return { contentType: asset.contentType, body };
  }
  observe(sessionId: string, ack: SpeechAck) {
    if (this.lastSpeech.get(sessionId) !== ack.speechId) throw new Fault("STALE_SPEECH_ACK");
    this.store.change(sessionId, (state, emit) => {
      const previous = state.speechAck;
      if (previous?.speechId === ack.speechId && previous.sequence >= ack.sequence) return;
      state.speechAck = ack;
      emit({ type: "speech.observed", payload: ack });
    });
    if (["ended", "failed", "blocked", "stopped"].includes(ack.status) &&
      this.store.read(sessionId).speechAck?.sequence === ack.sequence) {
      const advance = () => {
        const active = this.activeSpeech.get(sessionId);
        if (active?.id !== ack.speechId) return;
        clearTimeout(active.timer);
        this.activeSpeech.delete(sessionId);
        if (ack.status !== "ended") { this.speechQueues.delete(sessionId); return; }
        const item = this.speechQueues.get(sessionId)?.shift();
        if (item && !this.closed && this.store.read(sessionId).settings.autoSpeech) this.start(sessionId, item);
      };
      const job = this.jobs.get(sessionId);
      if (job) void job.promise.then(advance); else advance();
    }
  }
  async idle() { await Promise.all([...this.pending]); }
  cancelAll() {
    for (const sessionId of new Set([...this.jobs.keys(), ...this.lastSpeech.keys()])) this.cancel(sessionId);
  }
  async close() {
    this.closed = true;
    for (const active of this.activeSpeech.values()) clearTimeout(active.timer);
    this.activeSpeech.clear();
    this.speechQueues.clear();
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.all([...this.pending]);
    for (const [id, asset] of this.assets) this.remove(id, asset);
  }
}
