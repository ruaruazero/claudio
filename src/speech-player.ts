import { audioEngine } from "./audio-engine";

export class Pcm16Decoder {
  private tail: number | undefined;
  push(chunk: Uint8Array) {
    let bytes = chunk;
    if (this.tail !== undefined) {
      bytes = new Uint8Array(chunk.length + 1);
      bytes[0] = this.tail;
      bytes.set(chunk, 1);
    }
    const length = bytes.length - bytes.length % 2;
    this.tail = length === bytes.length ? undefined : bytes[length];
    const samples = new Float32Array(length / 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, length);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    return samples;
  }
  finish() { if (this.tail !== undefined) throw new Error("TTS_INVALID_PCM"); }
}

type Callbacks = {
  playing: () => void; ended: () => void; failed: (blocked: boolean) => void;
};

export class SpeechStreamPlayer {
  private context: AudioContext | null = null;
  private controller: AbortController | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private generation = 0;
  private startTimer: ReturnType<typeof setTimeout> | undefined;

  unlock() {
    this.context ??= audioEngine.getContext();
    return audioEngine.unlock();
  }
  stop() {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    clearTimeout(this.startTimer);
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear();
  }
  async close() { this.stop(); this.context = null; }

  async play(url: string, sampleRate: number, callbacks: Callbacks) {
    this.stop();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const current = () => generation === this.generation && !controller.signal.aborted;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.context ??= audioEngine.getContext();
      const context = this.context;
      if (context.state !== "running") await Promise.race([
        context.resume(), new Promise<never>((_, reject) => {
          resumeTimer = setTimeout(() => reject(new DOMException("Audio needs a user gesture", "NotAllowedError")), 1200);
        }),
      ]);
      clearTimeout(resumeTimer);
      if (!current()) return;
      const response = await fetch(url, { cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]) });
      if (!response.ok || !response.body) throw new Error("TTS_STREAM_UNAVAILABLE");
      reader = response.body.getReader();
      const decoder = new Pcm16Decoder();
      let nextAt = 0, totalBytes = 0, received = false, finished = false;
      let pending: Float32Array[] = [], pendingLength = 0;
      const finish = () => {
        if (finished && !this.sources.size && current()) {
          this.controller = null;
          callbacks.ended();
        }
      };
      const schedule = (samples: Float32Array) => {
        if (!samples.length || !current()) return;
        const buffer = context.createBuffer(1, samples.length, sampleRate);
        buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(audioEngine.analyser("speech"));
        const at = Math.max(nextAt, context.currentTime + 0.06);
        nextAt = at + buffer.duration;
        this.sources.add(source);
        source.onended = () => { source.disconnect(); this.sources.delete(source); finish(); };
        source.start(at);
        if (!received) {
          received = true;
          this.startTimer = setTimeout(() => {
            if (current() && context.state === "running") callbacks.playing();
          }, Math.max(0, (at - context.currentTime) * 1000));
        }
      };
      const flush = () => {
        const samples = new Float32Array(pendingLength);
        let offset = 0;
        for (const part of pending) { samples.set(part, offset); offset += part.length; }
        pending = []; pendingLength = 0;
        schedule(samples);
      };
      while (true) {
        const item = await reader.read();
        if (!current()) return;
        if (item.done) break;
        totalBytes += item.value.length;
        if (totalBytes > 9_000_000) throw new Error("TTS_STREAM_TOO_LARGE");
        const samples = decoder.push(item.value);
        if (!received) {
          pending.push(samples); pendingLength += samples.length;
          if (pendingLength >= sampleRate * 0.15) flush();
        } else schedule(samples);
      }
      decoder.finish();
      if (pendingLength) flush();
      if (!received) throw new Error("TTS_EMPTY_AUDIO");
      finished = true;
      finish();
    } catch (error) {
      if (current()) {
        const blocked = error instanceof DOMException && error.name === "NotAllowedError";
        this.stop();
        callbacks.failed(blocked);
      }
    } finally {
      clearTimeout(resumeTimer);
      await reader?.cancel().catch(() => {});
    }
  }
}
