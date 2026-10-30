import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { makeApp } from "./http.js";
import { MimoSpeech, spokenText, type SpeechProvider } from "./speech.js";
import type { Music } from "./music.js";
import type { Message, Track } from "../src/protocol.js";
import { MediaPauseGuard, waitForPlaybackBuffer, playWithConfirmation } from "../src/playback.js";

test("internal media pauses are consumed without masking a later external interruption", () => {
  const guard = new MediaPauseGuard();
  const audio = { paused: false } as HTMLMediaElement;
  guard.mutate(audio, () => {});
  assert.equal(guard.consume(audio), true);
  assert.equal(guard.consume(audio), false);
  guard.mutate(audio, () => {});
  guard.playing(audio);
  assert.equal(guard.consume(audio), false, "Resumed playback clears expectations even when loading emitted no pause");
  const standby = { paused: true } as HTMLMediaElement;
  guard.mutate(standby, () => {});
  assert.equal(guard.consume(standby), false);
});

test("play promise confirms already-playing audio without requiring another playing event", async () => {
  let confirmations = 0;
  const audio = { paused: false, ended: false, async play() {} };
  await playWithConfirmation(audio, () => true, () => { confirmations++; });
  assert.equal(confirmations, 1);
});

test("a delayed play promise cannot confirm a superseded or paused command", async () => {
  let finish!: () => void;
  let current = true;
  let confirmations = 0;
  const audio = { paused: false, ended: false, play: () => new Promise<void>(resolve => { finish = resolve; }) };
  const pending = playWithConfirmation(audio, () => current, () => { confirmations++; });
  current = false;
  finish();
  await pending;
  assert.equal(confirmations, 0);
  audio.paused = true;
  audio.play = async () => {};
  await playWithConfirmation(audio, () => true, () => { confirmations++; });
  assert.equal(confirmations, 0);
});

const tracks: Track[] = Array.from({ length: 8 }, (_, i) => ({
  id: `track-${i}`, title: `Track ${i}`, artist: "Fixture", durationMs: 180_000,
}));
const music: Music = {
  async search() { return tracks; },
  async inspect(track) {
    return { availability: "full", url: `http://localhost/${track.id}.wav`,
      reason: "fixture", expiresAt: Date.now() + 120_000 };
  },
};
function fixture(speech?: SpeechProvider) {
  const lab = makeApp({ databasePath: ":memory:", model: null, modelName: null, music, speech });
  lab.store.create("s1");
  return lab;
}
function reply(id = "reply"): Message {
  return { id, role: "assistant", source: "model", text: "**你好**，慢慢来。",
    status: "complete", createdAt: new Date().toISOString() };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
test("card selection replaces only current playback, survives candidate eviction, and is idempotent", async () => {
  const { app, store, resources } = fixture();
  try {
    store.change("s1", (state) => {
      state.radio.current = tracks[0]; state.radio.queue = tracks.slice(1, 4);
      state.messages.push({ ...reply("card"), tracks: [tracks[6]] });
    });
    const before = store.read("s1").radio;
    const response = await app.inject({ method: "POST", url: "/api/lab/sessions/s1/recommendations/prepare",
      payload: { messageId: "card", trackId: tracks[6].id } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(store.read("s1").radio, before, "Preparing never changes playback");
    const operation = { commandId: "card-select", action: "select", expectedPlaybackVersion: 0,
      trackId: tracks[6].id, messageId: "card" };
    for (let i = 0; i < 2; i++) {
      const selected = await app.inject({ method: "POST", url: "/api/lab/sessions/s1/playback/local", payload: operation });
      assert.equal(selected.statusCode, 200);
    }
    const after = store.read("s1");
    assert.equal(after.radio.current?.id, tracks[6].id);
    assert.deepEqual(after.radio.queue, before.queue);
    assert.equal(after.radio.queueVersion, before.queueVersion);
    assert.equal(after.radio.playbackVersion, 1);
    assert.equal(after.command?.action, "play");
    assert.equal(after.command?.resume, false);
    assert.equal(store.replay("s1", 0).filter((e) => e.type === "playback.command").length, 0);
    await resources.refresh("s1");
    await app.inject({ method: "POST", url: "/api/lab/sessions/s1/playback/local", payload: {
      commandId: "after-card", action: "next", expectedPlaybackVersion: 1, trackId: tracks[1].id } });
    assert.equal(store.read("s1").radio.current?.id, tracks[1].id);
    const rejected = await app.inject({ method: "POST", url: "/api/lab/sessions/s1/recommendations/prepare",
      payload: { messageId: "card", trackId: "forged" } });
    assert.equal(rejected.statusCode, 404);
  } finally { await app.close(); }
});

test("play commands carry resume intent while next and queue replacements start a new track", async () => {
  const { app, store, agent } = fixture();
  try {
    store.change("s1", (state) => { state.radio.current = tracks[0]; state.radio.queue = [tracks[1]]; });
    await agent.control({ action: "play", expectedPlaybackVersion: 0 }, "s1", "resume");
    assert.equal(store.read("s1").command?.resume, true);
    await agent.control({ action: "next", expectedPlaybackVersion: 1 }, "s1", "next");
    assert.equal(store.read("s1").command?.resume, false);
  } finally { await app.close(); }
});

test("expired prefetch is refreshed before accepting an automatic preview transition", async () => {
  const lab = makeApp({ databasePath: ":memory:", model: null, modelName: null, music });
  const { app, store } = lab;
  try {
    store.create("s1");
    store.change("s1", (state) => {
      state.radio.current = { ...tracks[0], availability: "preview_only", playableDurationMs: 30_000 };
      state.radio.queue = [tracks[1]];
      state.candidates = [{ id: "old", requestId: "old", track: tracks[1],
        resource: { availability: "full", url: "http://localhost/expired", expiresAt: Date.now() - 1, reason: "expired" } }];
    });
    const response = await app.inject({ method: "POST", url: "/api/lab/sessions/s1/playback/local",
      payload: { commandId: "automatic", action: "next", reason: "ended", expectedPlaybackVersion: 0, trackId: tracks[1].id } });
    assert.equal(response.statusCode, 200);
    assert.equal(store.read("s1").radio.current?.id, tracks[1].id);
    assert.equal(store.read("s1").desiredPlayback, "play");
    assert.ok(!store.replay("s1", 0).some((e) => e.type === "playback.command" && e.payload.action === "pause"));
  } finally { await app.close(); }
});

test("consecutive replies speak in order after playback ends, and interruption clears the rest", async () => {
  const spoken: string[] = [];
  const { app, store, speech } = fixture({ async synthesize(text) {
    spoken.push(text); return { bytes: wav(), contentType: "audio/wav" };
  } });
  try {
    store.change("s1", (state) => { state.settings.autoSpeech = true; });
    speech.watch("s1");
    for (const id of ["one", "two", "three"]) store.change("s1", (_, emit) => emit({
      type: "reply.final", requestId: "same", payload: { ...reply(id), text: id, requestId: "same" },
    }));
    await tick(); await speech.idle();
    assert.deepEqual(spoken, ["one"], "Synthesis completion alone does not advance playback");
    let ready = store.replay("s1", 0).filter((e) => e.type === "speech.ready").at(-1)!;
    assert.equal(ready.type, "speech.ready");
    if (ready.type !== "speech.ready") return;
    speech.observe("s1", { speechId: ready.payload.speechId, sequence: 1, status: "ended" });
    await tick(); await speech.idle();
    assert.deepEqual(spoken, ["one", "two"]);
    speech.cancel("s1");
    await tick(); await speech.idle();
    assert.deepEqual(spoken, ["one", "two"], "User interruption discards third message audio");
  } finally { await app.close(); }
});
function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF"); bytes.writeUInt32LE(40, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
  bytes.writeUInt32LE(4, 40);
  return bytes;
}

test("local consecutive next is idempotent, ordered and never echoes playback commands", async () => {
  const { app, store, resources } = fixture();
  try {
    store.change("s1", (state) => { state.radio.current = tracks[0]; state.radio.queue = tracks.slice(1, 5); });
    await resources.refresh("s1");
    const next = { commandId: "next-1", action: "next" as const, expectedPlaybackVersion: 0, trackId: tracks[1].id };
    assert.deepEqual(resources.observeLocal("s1", next), { accepted: true, playbackVersion: 1 });
    resources.observeLocal("s1", next);
    resources.observeLocal("s1", { ...next, commandId: "next-2", expectedPlaybackVersion: 1, trackId: tracks[2].id });
    resources.observeLocal("s1", { commandId: "pause", action: "pause", expectedPlaybackVersion: 2 });
    assert.equal(store.read("s1").radio.current?.id, tracks[2].id);
    assert.equal(store.read("s1").radio.queue.length, 2);
    assert.equal(store.read("s1").desiredPlayback, "pause");
    assert.equal(store.replay("s1", 0).filter((e) => e.type === "playback.command").length, 0);
    const before = store.read("s1");
    assert.throws(() => resources.observeLocal("s1", { ...next, commandId: "stale" }), /VERSION_CONFLICT/);
    assert.deepEqual(store.read("s1"), before);
  } finally { await app.close(); }
});

test("resource preparation coalesces queries and publishes only changes; local pause needs no resource", async () => {
  const { app, store, resources } = fixture();
  try {
    store.change("s1", (state) => { state.radio.current = tracks[0]; state.radio.queue = tracks.slice(1, 4); });
    const first = resources.refresh("s1");
    assert.equal(resources.refresh("s1"), first);
    await first;
    await resources.refresh("s1");
    assert.equal(store.replay("s1", 0).filter((e) => e.type === "resources.ready").length, 1);
    store.change("s1", (state) => { state.radio.current = null; state.radio.queue = []; });
    resources.observeLocal("s1", { commandId: "pause", action: "pause", expectedPlaybackVersion: 0 });
    assert.equal(store.read("s1").desiredPlayback, "pause");
  } finally { await app.close(); }
});

test("background refill rebases over repeated skips but rejects a changed selection direction", async () => {
  const { app, agent, store } = fixture();
  try {
    store.change("s1", (state) => {
      state.backgroundRequestId = "bg";
      state.radio.current = tracks[0];
      state.radio.queue = tracks.slice(1, 4);
      state.candidates = tracks.slice(2).map((track) => ({ id: track.id, requestId: "bg", track,
        resource: { availability: "full", url: `http://localhost/${track.id}.wav`,
          reason: "test", expiresAt: Date.now() + 120_000 } }));
    });
    const context = { sessionId: "s1", requestId: "bg", controlEpoch: 0, selectionEpoch: 0, background: true };
    store.change("s1", (state) => {
      state.controlEpoch += 3;
      state.radio.current = state.radio.queue.shift()!;
      state.radio.queueVersion++;
    });
    const input = { candidateIds: tracks.slice(2).map((t) => t.id),
      mode: "append" as const, timing: "after_current" as const, expectedQueueVersion: 0 };
    agent.updateQueue(input, context, "refill");
    const queue = store.read("s1").radio.queue;
    assert.equal(queue.length, 6);
    assert.equal(new Set(queue.map((t) => t.id)).size, 6);
    assert.equal(store.read("s1").command, null);
    store.change("s1", (state) => { state.selectionEpoch++; });
    assert.throws(() => agent.updateQueue(input, context, "old-direction"), /SELECTION_SUPERSEDED/);
  } finally { await app.close(); }
});

test("MiMo uses assistant text and returns WAV; provider errors do not expose the key", async () => {
  let status = 200;
  let received: any;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { audio: { data: wav().toString("base64") } } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  try {
    const provider = new MimoSpeech("test-secret", undefined, undefined, `http://127.0.0.1:${address.port}/v1`);
    const result = await provider.synthesize("你好", new AbortController().signal);
    assert.equal(result.contentType, "audio/wav");
    assert.deepEqual(result.bytes, wav());
    assert.equal(received.headers["api-key"], "test-secret");
    assert.equal(received.body.model, "mimo-v2.5-tts");
    assert.deepEqual(received.body.messages.at(-1), { role: "assistant", content: "你好" });
    assert.deepEqual(received.body.audio, { format: "wav", voice: "mimo_default" });
    for (const [code, error] of [[401, "TTS_AUTH_FAILED"], [402, "TTS_BALANCE"],
      [403, "TTS_PERMISSION_DENIED"], [404, "TTS_CONFIGURATION"],
      [429, "TTS_RATE_LIMITED"], [500, "TTS_PROVIDER_FAILED"]] as const) {
      status = code;
      await assert.rejects(provider.synthesize("你好", new AbortController().signal), { message: error });
    }
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("TTS is asynchronous, plain text only, opt-in, and serves expiring backend audio", async () => {
  let said = "";
  const { app, store, speech } = fixture({ async synthesize(text) {
    said = text; return { bytes: wav(), contentType: "audio/wav" };
  } });
  try {
    speech.watch("s1");
    store.change("s1", (_, emit) => emit({ type: "reply.final", payload: reply("off") }));
    await tick();
    assert.equal(said, "");
    store.change("s1", (state) => { state.settings.autoSpeech = true; });
    store.change("s1", (_, emit) => emit({ type: "reply.final", payload: reply() }));
    await tick(); await speech.idle();
    assert.equal(said, "你好，慢慢来。");
    const event = store.replay("s1", 0).find((e) => e.type === "speech.ready");
    assert.ok(event?.type === "speech.ready");
    const response = await app.inject({ url: event.payload.url });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.rawPayload, wav());
    speech.cancel("s1");
    assert.equal((await app.inject({ url: event.payload.url })).statusCode, 404);
    assert.equal(store.read("s1").radio.playbackVersion, 0);
    const sequences = store.replay("s1", 0).map((e) => e.sequence);
    assert.deepEqual(sequences, sequences.map((_, i) => i + 1));
  } finally { await app.close(); }
});

test("stop or disabling speech prevents delayed synthesis from publishing audio", async () => {
  for (const mode of ["stop", "disable"] as const) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { app, store, speech } = fixture({ async synthesize() {
      await gate; return { bytes: wav(), contentType: "audio/wav" };
    } });
    try {
      speech.watch("s1");
      store.change("s1", (state) => { state.settings.autoSpeech = true; });
      store.change("s1", (_, emit) => emit({ type: "reply.final", payload: reply() }));
      await tick();
      if (mode === "stop") speech.cancel("s1");
      else store.change("s1", (state, emit) => {
        state.settings.autoSpeech = false;
        emit({ type: "settings.updated", payload: state.settings });
      });
      await tick();
      release();
      await speech.idle();
      assert.equal(store.replay("s1", 0).some((e) => e.type === "speech.ready"), false);
    } finally { release(); await app.close(); }
  }
});

test("pause discards delayed proactive speech while direct replies remain available", async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const { app, store, resources, speech } = fixture({ async synthesize() {
    if (++calls === 1) { started(); await gate; }
    return { bytes: wav(), contentType: "audio/wav" };
  } });
  try {
    speech.watch("s1");
    store.change("s1", (state) => {
      state.settings.autoSpeech = true;
      state.radio.current = tracks[0];
      state.playbackAck = { commandId: "playing", playbackVersion: 0, ackSequence: 1,
        status: "playing", positionMs: 0 };
    });
    store.change("s1", (_, emit) => emit({ type: "reply.final", payload: { ...reply("segue"), proactive: true } }));
    await began;
    resources.observeLocal("s1", { commandId: "pause", action: "pause", expectedPlaybackVersion: 0 });
    await tick();
    release();
    await speech.idle();
    assert.equal(store.replay("s1", 0).some((event) => event.type === "speech.ready"), false);
    store.change("s1", (_, emit) => emit({ type: "reply.final", payload: { ...reply("late-segue"), proactive: true } }));
    await tick(); await speech.idle();
    assert.equal(calls, 1, "A late proactive reply cannot start new speech during pause");
    store.change("s1", (_, emit) => emit({ type: "reply.final", payload: reply("direct") }));
    await tick(); await speech.idle();
    assert.equal(calls, 2);
    assert.equal(store.replay("s1", 0).filter((event) => event.type === "speech.ready").length, 1);
  } finally { release(); await app.close(); }
});

test("TTS provider failure leaves chat and playback intact", async () => {
  const { app, store, speech } = fixture({ async synthesize() { throw new Error("private provider failure"); } });
  try {
    speech.watch("s1");
    store.change("s1", (state, emit) => {
      state.settings.autoSpeech = true;
      state.messages.push(reply());
      emit({ type: "reply.final", payload: reply() });
    });
    await tick(); await speech.idle();
    const failed = store.replay("s1", 0).find((e) => e.type === "speech.failed");
    assert.ok(failed?.type === "speech.failed");
    assert.equal(failed.payload.code, "TTS_NETWORK_OR_TIMEOUT");
    assert.equal(store.read("s1").messages.length, 1);
    assert.equal(store.read("s1").radio.playbackVersion, 0);
    assert.equal(spokenText("[歌名](https://example.com) **你好**\n```js\nsecret\n```"), "歌名 你好");
  } finally { await app.close(); }
});

test("tiny media chunks wait for a buffer reserve and pause cancels the wait", async () => {
  const media = new EventTarget();
  let buffered = 0.2;
  Object.assign(media, { readyState: 3, currentTime: 0, duration: 24,
    buffered: { length: 1, start: () => 0, end: () => buffered } });
  let ready = false;
  const controller = new AbortController();
  const waiting = waitForPlaybackBuffer(media as HTMLMediaElement, controller.signal).then(() => { ready = true; });
  await tick();
  assert.equal(ready, false);
  buffered = 3.2;
  media.dispatchEvent(new Event("progress"));
  await waiting;
  assert.equal(ready, true);
  buffered = 0;
  const cancelled = waitForPlaybackBuffer(media as HTMLMediaElement, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  Object.assign(media, { error: { code: 2 } });
  await assert.rejects(waitForPlaybackBuffer(media as HTMLMediaElement, new AbortController().signal),
    { message: "MEDIA_RESOURCE_FAILED" });
});
