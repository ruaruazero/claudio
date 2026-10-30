import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { makeApp } from "./http.js";
import { MimoSpeech, type SpeechProvider } from "./speech.js";
import { Pcm16Decoder } from "../src/speech-player.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const reply = { id: "stream-reply", role: "assistant" as const, source: "model" as const,
  status: "complete" as const, text: "你好，我在。", createdAt: new Date().toISOString() };
function fixture(provider: SpeechProvider) {
  const lab = makeApp({ databasePath: ":memory:", model: null, modelName: null,
    speech: provider, music: { async search() { return []; }, async inspect() { throw new Error("not used"); } } });
  lab.store.create("s1");
  lab.store.change("s1", (state) => { state.settings.autoSpeech = true; });
  lab.speech.watch("s1");
  return lab;
}
const fallback = async () => ({ bytes: Buffer.alloc(44), contentType: "audio/wav" });

test("manual message playback works with automatic speech disabled and validates stored messages", async () => {
  const spoken: string[] = [];
  const { app, store, speech } = fixture({
    synthesize: fallback,
    async *stream(text) { spoken.push(text); yield Buffer.alloc(9600, 12); },
  });
  try {
    await app.ready();
    store.change("s1", state => { state.settings.autoSpeech = false; state.messages.push(reply); });
    const invalid = await app.inject({ method: "POST", url: "/api/lab/sessions/s1/speech/replay",
      payload: { messageId: "unknown" } });
    assert.equal(invalid.statusCode, 404);
    assert.equal(spoken.length, 0);
    const response = await app.inject({ method: "POST", url: "/api/lab/sessions/s1/speech/replay",
      payload: { messageId: reply.id } });
    assert.equal(response.statusCode, 200);
    await speech.idle();
    assert.deepEqual(spoken, [reply.text]);
    assert.equal(store.read("s1").settings.autoSpeech, false);
    const ready = store.replay("s1", 0).find(event => event.type === "speech.ready");
    assert.ok(ready?.type === "speech.ready" && ready.payload.manual);
    assert.equal(speech.get(ready.payload.speechId).size, 9600);
    const stop = await app.inject({ method: "POST", url: "/api/lab/sessions/s1/speech/stop", payload: {} });
    assert.equal(stop.statusCode, 200);
    assert.throws(() => speech.get(ready.payload.speechId), /SPEECH_EXPIRED/);
  } finally { await app.close(); }
});

test("MiMo stream parses fragmented SSE and yields PCM before generation completes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let received: any;
  const pcm = Buffer.from([0, 0, 255, 127, 0, 128]);
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = Buffer.from(`: 语音\r\ndata: ${JSON.stringify({ choices: [{ delta: {
      audio: { data: pcm.toString("base64") } }, finish_reason: null }] })}\r\n\r\n`);
    for (let i = 0; i < event.length; i += 5) { res.write(event.subarray(i, i + 5)); await tick(); }
    await gate;
    res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const provider = new MimoSpeech("secret", undefined, undefined, `http://127.0.0.1:${(server.address() as any).port}`);
    const iterator = provider.stream("你好", new AbortController().signal)[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.deepEqual(first.value, pcm);
    assert.equal(received.stream, true);
    assert.equal(received.audio.format, "pcm16");
    release();
    assert.equal((await iterator.next()).done, true);
  } finally { release(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});

for (const mode of ["truncated", "invalid-base64", "filtered"] as const) {
  test(`MiMo rejects incomplete or malformed PCM streams: ${mode}`, async () => {
    const server = createServer((_, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const choice = { delta: { audio: { data: mode === "invalid-base64" ? "wrong!" : "AAAAAA==" } },
        finish_reason: mode === "filtered" ? "content_filter" : null };
      res.end(`data: ${JSON.stringify({ choices: [choice] })}\n\n`);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const provider = new MimoSpeech("secret", undefined, undefined, `http://127.0.0.1:${(server.address() as any).port}`);
      await assert.rejects(async () => {
        for await (const _ of provider.stream("你好", new AbortController().signal)) {}
      }, /TTS_(INCOMPLETE|INVALID)_AUDIO/);
    } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
  });
}

test("HTTP relays the first PCM chunk before completion and records ordered playback ACKs", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pcm = Buffer.alloc(9600, 12);
  const { app, store, speech, agent } = fixture({
    synthesize: fallback, async *stream() { yield pcm; await gate; yield pcm; },
  });
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    store.change("s1", (_, emit) => emit({ type: "reply.final", payload: reply }));
    await tick();
    const ready = store.replay("s1", 0).find((e) => e.type === "speech.ready");
    assert.ok(ready?.type === "speech.ready");
    assert.equal(ready.payload.format, "pcm16");
    assert.equal(ready.payload.sampleRate, 24000);
    assert.equal(store.replay("s1", 0).some((e) => e.type === "speech.completed"), false);
    const response = await fetch(`${origin}${ready.payload.url}`);
    const reader = response.body!.getReader();
    assert.deepEqual(Buffer.from((await reader.read()).value!), pcm);
    speech.observe("s1", { speechId: ready.payload.speechId, sequence: 1, status: "playing" });
    assert.equal(agent.radioState("s1").speech.playback, "playing");
    release();
    const rest: Buffer[] = [];
    for (;;) { const item = await reader.read(); if (item.done) break; rest.push(Buffer.from(item.value)); }
    assert.deepEqual(Buffer.concat(rest), pcm);
    await speech.idle();
    const completed = store.replay("s1", 0).find((e) => e.type === "speech.completed");
    assert.ok(completed?.type === "speech.completed");
    assert.equal(completed.payload.chunks, 2);
    speech.observe("s1", { speechId: ready.payload.speechId, sequence: 3, status: "ended" });
    speech.observe("s1", { speechId: ready.payload.speechId, sequence: 2, status: "playing" });
    assert.equal(agent.radioState("s1").speech.playback, "ended");
    speech.cancel("s1");
    assert.equal(agent.radioState("s1").speech.playback, "ended");
  } finally { release(); await app.close(); }
});

test("cancel closes a pending HTTP stream and suppresses later PCM", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { app, store, speech } = fixture({
    synthesize: fallback, async *stream() { yield Buffer.alloc(9600); await gate; yield Buffer.alloc(9600); },
  });
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    store.change("s1", (_, emit) => emit({ type: "reply.final", payload: reply }));
    await tick();
    const ready = store.replay("s1", 0).find((e) => e.type === "speech.ready");
    assert.ok(ready?.type === "speech.ready");
    const response = await fetch(`${origin}${ready.payload.url}`);
    const reader = response.body!.getReader();
    await reader.read();
    const stopped = reader.read();
    speech.cancel("s1");
    release();
    await assert.rejects(stopped);
    await speech.idle();
    assert.equal(store.replay("s1", 0).some((e) => e.type === "speech.completed"), false);
    assert.throws(() => speech.get(ready.payload.speechId), /SPEECH_EXPIRED/);
  } finally { release(); await app.close(); }
});

test("PCM decoder preserves little-endian sample boundaries across odd network chunks", () => {
  const decoder = new Pcm16Decoder();
  assert.deepEqual([...decoder.push(Uint8Array.from([0]))], []);
  assert.deepEqual([...decoder.push(Uint8Array.from([128, 0, 0, 255]))], [-1, 0]);
  assert.deepEqual([...decoder.push(Uint8Array.from([127]))], [32767 / 32768]);
  decoder.finish();
  decoder.push(new Uint8Array([1]));
  assert.throws(() => decoder.finish(), /TTS_INVALID_PCM/);
});
