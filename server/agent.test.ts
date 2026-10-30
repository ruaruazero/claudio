import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatDeepSeek } from "@langchain/deepseek";
import { AIMessage, type BaseMessage, isToolMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { Track } from "../src/protocol.js";
import { makeApp } from "./http.js";
import type { Music } from "./music.js";
import { NeteaseMusic } from "./music.js";
import { MockMusic } from "./mock-music.js";
import { classifyFailure } from "./incidents.js";
import { conversationPersona } from "./persona.js";
import { playbackObservations, savePlaybackObservation, removePlaybackObservation,
  playbackReceipts, savePlaybackReceipt, removePlaybackReceipt } from "../src/storage.js";

test("playback outbox keeps the latest observation and survives a repeated read", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  } });
  try {
    const ack = { commandId: "cmd", playbackVersion: 1, ackSequence: 1,
      status: "playing" as const, positionMs: 0 };
    savePlaybackObservation("/api", "s1", ack);
    const inFlight = playbackObservations()[0];
    savePlaybackObservation("/api", "s1", { ...ack, ackSequence: 2, status: "ended" });
    removePlaybackObservation(inFlight);
    assert.equal(playbackObservations().length, 1, "An old response cannot delete a newer queued observation");
    assert.equal(playbackObservations()[0].ack.status, "ended");
    removePlaybackObservation(playbackObservations()[0]);
    assert.deepEqual(playbackObservations(), []);
    const receipt = { commandId: "cmd", playbackVersion: 1, phase: "received" as const };
    savePlaybackReceipt("/api", "s1", receipt);
    const sendingReceipt = playbackReceipts()[0];
    savePlaybackReceipt("/api", "s1", { ...receipt, phase: "executing" });
    removePlaybackReceipt(sendingReceipt);
    assert.equal(playbackReceipts()[0].receipt.phase, "executing", "A sent receipt cannot delete newer progress");
    removePlaybackReceipt(playbackReceipts()[0]);
    assert.deepEqual(playbackReceipts(), []);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("preview policy is enforced on queue commit and playback without mutating state", async () => {
  const music: Music = { ...fixtureMusic(), async inspect() {
    return { availability: "preview_only", url: "http://127.0.0.1/trial.wav",
      playableDurationMs: 30_000, expiresAt: Date.now() + 60_000, reason: "trial" };
  } };
  const { app, store, agent } = makeApp({ model: null, modelName: null, databasePath: ":memory:", music });
  try {
    store.create("s1");
    store.change("s1", (state) => {
      state.activeRequestId = "r1";
      state.radio.current = tracks[1];
      state.candidates = [{ id: "trial", requestId: "r1", track: tracks[0], resource: {
        availability: "preview_only", url: "http://127.0.0.1/trial.wav",
        playableDurationMs: 30_000, expiresAt: Date.now() + 60_000, reason: "trial" } }];
    });
    const input = { candidateIds: ["trial"], mode: "replace" as const, timing: "after_current" as const,
      expectedQueueVersion: 0 };
    const context = { sessionId: "s1", requestId: "r1", controlEpoch: 0 };
    agent.updateQueue(input, context, "allowed");
    assert.equal(store.read("s1").radio.queue[0].playableDurationMs, 30_000);
    store.change("s1", (state) => { state.settings.allowPreview = false; });
    const before = store.read("s1").radio;
    assert.throws(() => agent.updateQueue({ ...input, expectedQueueVersion: 1 }, context, "denied"),
      /INSPECT_PLAYABLE_RESOURCES_FIRST/);
    await assert.rejects(agent.control({ action: "next", expectedPlaybackVersion: 0 }, "s1", "next"),
      /RESOURCE_UNAVAILABLE/);
    assert.deepEqual(store.read("s1").radio, before);
  } finally { await app.close(); }
});

test("implicit adaptation preserves playback and manual pause invalidates an older agent write", async () => {
  const { app, store, agent } = fixture(null);
  try {
    store.create("s1");
    store.change("s1", (state) => {
      state.activeRequestId = "r1";
      state.radio.current = tracks[1];
      state.candidates = [{ id: "candidate", requestId: "r1", track: tracks[2], resource: {
        availability: "full", url: "http://127.0.0.1/music.wav", reason: "test", expiresAt: Date.now() + 60_000 } }];
    });
    const context = { sessionId: "s1", requestId: "r1", controlEpoch: 0 };
    const input = { candidateIds: ["candidate"], mode: "replace" as const, timing: "now" as const,
      intent: "implicit_adaptation" as const, expectedQueueVersion: 0 };
    assert.throws(() => agent.updateQueue(input, context, "interrupt"), /IMPLICIT_UPCOMING_ONLY/);
    agent.updateQueue({ ...input, timing: "after_current" }, context, "upcoming");
    assert.equal(store.read("s1").radio.current?.id, tracks[1].id);
    assert.equal(store.read("s1").command, null);
    await agent.control({ action: "pause", expectedPlaybackVersion: 0 }, "s1", "manual:pause");
    assert.throws(() => agent.updateQueue({ ...input, timing: "after_current", expectedQueueVersion: 1 },
      context, "stale"), /CONTROL_SUPERSEDED/);
    assert.equal(store.read("s1").command?.action, "pause");
  } finally { await app.close(); }
});

test("implicit adaptation with no current track never starts playback; capacity failure is atomic", async () => {
  const { app, store, agent } = fixture(null);
  try {
    store.create("s1");
    store.change("s1", (state) => {
      state.activeRequestId = "r1";
      state.candidates = [{ id: "candidate", requestId: "r1", track: tracks[2], resource: {
        availability: "full", url: "http://127.0.0.1/music.wav", reason: "test", expiresAt: Date.now() + 60_000 } }];
    });
    const input = { candidateIds: ["candidate"], mode: "append" as const, timing: "after_current" as const,
      intent: "implicit_adaptation" as const, expectedQueueVersion: 0 };
    const context = { sessionId: "s1", requestId: "r1", controlEpoch: 0 };
    agent.updateQueue(input, context, "upcoming");
    assert.equal(store.read("s1").radio.current, null);
    assert.equal(store.read("s1").command, null);
    store.change("s1", (state) => { state.radio.queue = Array.from({ length: 10 }, () => tracks[1]); });
    const before = store.read("s1");
    assert.throws(() => agent.updateQueue({ ...input, expectedQueueVersion: 1 }, context, "overfill"), /QUEUE_CAPACITY/);
    assert.deepEqual(store.read("s1"), before);
  } finally { await app.close(); }
});

test("background refill adds inspected tracks once, without starting playback or publishing a reply", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const model = new ScriptModel([
    async () => { await gate; return call("recommend_music", { queries: ["quiet"], purpose: "queue", limit: 3 }); },
    (messages) => call("inspect_music", { candidateIds: result(messages, "recommend_music").candidates
      .filter((c: any) => c.id === tracks[2].id).map((c: any) => c.candidateId) }),
    (messages) => call("update_music_queue", {
      candidateIds: result(messages, "inspect_music").results.map((c: any) => c.candidateId),
      mode: "append", timing: "after_current", expectedQueueVersion: 0,
    }),
    () => new AIMessage("DO_NOT_PUBLISH_BACKGROUND_REPORT"),
  ]);
  const { app, agent, store } = fixture(model);
  try {
    store.create("s1");
    store.change("s1", (state) => { state.radio.current = tracks[1]; });
    await Promise.all([agent.maintain("s1"), agent.maintain("s1")]);
    agent.noteActivity("s1");
    store.change("s1", (state) => { state.controlEpoch += 3; state.radio.queueVersion += 3; });
    await Promise.all(Array.from({ length: 20 }, () => agent.maintain("s1")));
    release();
    await agent.idle();
    assert.equal(model.index, 4);
    assert.deepEqual(store.read("s1").radio.queue.map((t) => t.id), [tracks[2].id]);
    assert.equal(store.read("s1").command, null);
    assert.deepEqual(store.read("s1").messages, []);
    await agent.maintain("s1");
    await agent.idle();
    assert.equal(model.index, 4, "Cooldown prevents a tight refill loop");
  } finally { release(); await app.close(); }
});

for (const shortResources of [true, false]) {
  test(`refill checks available duration as well as track count: short=${shortResources}`, async () => {
    const model = new ScriptModel([() => new AIMessage("No suitable candidates")]);
    const { app, store, agent } = fixture(model);
    try {
      store.create("s1");
      store.change("s1", (state) => {
        state.radio.current = tracks[1];
        state.radio.queue = [tracks[0], tracks[2], tracks[0], tracks[2], tracks[0], tracks[2]].map((track) => ({ ...track,
          availability: shortResources ? "preview_only" : "full",
          playableDurationMs: shortResources ? 20_000 : 180_000 }));
      });
      await agent.maintain("s1");
      await agent.idle();
      assert.equal(model.index, shortResources ? 1 : 0);
      if (shortResources) {
        assert.equal(store.read("s1").maintenance.refillFailures, 1);
        assert.ok(store.read("s1").maintenance.nextRefillAt > Date.now());
      }
    } finally { await app.close(); }
  });
}

for (const count of [5, 6, 10]) {
  test(`queue refill low watermark is five: remaining=${count}`, async () => {
    const model = new ScriptModel([() => new AIMessage("No suitable candidates")]);
    const { app, store, agent } = fixture(model);
    try {
      store.create("s1");
      store.change("s1", state => {
        state.radio.current = tracks[1];
        state.radio.queue = Array.from({ length: count }, () => ({ ...tracks[0], durationMs: 180_000 }));
      });
      await agent.maintain("s1");
      await agent.idle();
      assert.equal(model.index, count <= 5 ? 1 : 0);
    } finally { await app.close(); }
  });
}

test("background tools cannot interrupt playback or replace the user's queue", async () => {
  const { app, store, agent } = fixture(null);
  try {
    store.create("s1");
    store.change("s1", (state) => { state.backgroundRequestId = "bg"; state.radio.current = tracks[1]; });
    const context = { sessionId: "s1", requestId: "bg", background: true, controlEpoch: 0 };
    assert.throws(() => agent.updateQueue({ candidateIds: ["anything"], mode: "replace", timing: "now",
      expectedQueueVersion: 0 }, context, "bg:replace"), /BACKGROUND_APPEND_ONLY/);
    await assert.rejects(agent.control({ action: "pause", expectedPlaybackVersion: 0 }, "s1", "bg:pause",
      new AbortController().signal, context), /BACKGROUND_CANNOT_CONTROL/);
    assert.equal(store.read("s1").command, null);
  } finally { await app.close(); }
});

test("paused radio stays quiet across maintenance ticks but still answers the user", async () => {
  const model = new ScriptModel([() => new AIMessage("我在。")]);
  const { app, store, agent } = fixture(model);
  try {
    store.create("s1");
    store.change("s1", (state) => {
      state.radio.current = tracks[1];
      state.desiredPlayback = "pause";
      state.maintenance.endedCount = 20;
    });
    for (let i = 0; i < 20; i++) await agent.maintain("s1");
    await agent.idle();
    assert.equal(model.index, 0, "Neither low queue nor an old segue opportunity wakes a paused radio");
    agent.submit("s1", message("paused-chat", "你还在吗？"));
    await agent.idle();
    assert.equal(model.index, 1);
    assert.equal(store.read("s1").messages.at(-1)?.text, "我在。");
    assert.equal(store.read("s1").desiredPlayback, "pause");
  } finally { await app.close(); }
});

test("local pause cancels an in-flight refill before it can call tools", async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { started = resolve; });
  const model = new ScriptModel([async () => {
    started(); await gate;
    return call("search_music", { query: "quiet", limit: 3 });
  }]);
  const { app, store, agent, resources } = fixture(model);
  try {
    store.create("s1");
    store.change("s1", (state) => { state.radio.current = tracks[1]; });
    await agent.maintain("s1");
    await began;
    resources.observeLocal("s1", { commandId: "local-pause", action: "pause", expectedPlaybackVersion: 0 });
    release();
    await agent.idle();
    assert.equal(store.read("s1").radio.queue.length, 0);
    assert.equal(store.read("s1").backgroundRequestId, null);
    assert.equal(store.replay("s1", 0).some((event) => event.type === "agent.activity"), false);
    for (let i = 0; i < 3; i++) await agent.maintain("s1");
    assert.equal(model.index, 1);
  } finally { release(); await app.close(); }
});

for (const outcome of ["publish", "skip", "typing", "pause", "disabled", "local-pause"] as const) {
  test(`proactive segue respects opportunity and publish-time checks: ${outcome}`, async () => {
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const model = new ScriptModel([async () => {
      started(); await gate;
      return new AIMessage(JSON.stringify({ say: outcome === "skip" ? null : "这段旋律很适合慢慢听。" }));
    }]);
    const { app, store, agent, resources } = fixture(model);
    try {
      store.create("s1");
      store.change("s1", (state) => {
        state.radio.current = tracks[1];
        state.radio.queue = Array.from({ length: 6 }, () => tracks[2]);
        state.playbackAck = { commandId: "cmd", playbackVersion: 0, ackSequence: 1,
          status: "playing", positionMs: 0 };
        state.maintenance.endedCount = 2;
      });
      await agent.maintain("s1");
      await began;
      if (outcome === "typing") agent.noteActivity("s1");
      if (outcome === "pause") await agent.control({ action: "pause", expectedPlaybackVersion: 0 }, "s1", "manual:pause");
      if (outcome === "local-pause") resources.observeLocal("s1", {
        commandId: "local-pause", action: "pause", expectedPlaybackVersion: 0,
      });
      if (outcome === "disabled") store.change("s1", (state) => { state.settings.proactive = false; });
      release();
      await agent.idle();
      const messages = store.read("s1").messages;
      assert.equal(messages.length, outcome === "publish" ? 1 : 0);
      assert.ok(messages.every((m) => m.role === "assistant" && m.proactive));
      assert.equal(store.read("s1").activeRequestId, null);
    } finally { release(); await app.close(); }
  });
}

test("ended transition is terminal, durable next retries, and an empty queue does not consume retries", async () => {
  let failures = 1;
  const music: Music = { ...fixtureMusic(), async inspect(track, signal) {
    if (failures-- > 0) throw new Error("temporary outage");
    return fixtureMusic().inspect(track, signal);
  } };
  const { app, agent, store } = makeApp({ model: null, modelName: null, databasePath: ":memory:", music });
  try {
    store.create("s1");
    store.change("s1", (state) => {
      state.radio.current = tracks[1];
      state.command = { commandId: "cmd", playbackVersion: 0, action: "play",
        track: tracks[1], expiresAt: new Date(Date.now() + 60_000).toISOString() };
    });
    const ack = { commandId: "cmd", playbackVersion: 0, ackSequence: 1, status: "ended", positionMs: 180_000 };
    assert.equal((await post(app, "/api/lab/sessions/s1/playback/acks", ack)).statusCode, 200);
    assert.equal(store.read("s1").maintenance.pendingEnd?.attempts, 0);
    const late = await post(app, "/api/lab/sessions/s1/playback/acks", { ...ack, status: "playing", ackSequence: 2 });
    assert.equal(late.statusCode, 409);
    assert.equal(store.read("s1").playbackAck?.status, "ended");
    store.change("s1", (state) => { state.radio.queue = [tracks[2]]; state.maintenance.pendingEnd!.retryAt = 0; });
    await agent.maintain("s1");
    assert.equal(store.read("s1").maintenance.pendingEnd?.attempts, 1);
    assert.equal(store.read("s1").radio.current?.id, tracks[1].id);
    store.change("s1", (state) => { state.maintenance.pendingEnd!.retryAt = 0; });
    await Promise.all([agent.maintain("s1"), agent.maintain("s1")]);
    assert.equal(store.read("s1").radio.current?.id, tracks[2].id);
    assert.equal(store.read("s1").maintenance.pendingEnd, null);
    assert.equal(store.replay("s1", 0).filter((e) => e.type === "playback.command").length, 1);
    assert.equal((await post(app, "/api/lab/sessions/s1/playback/acks", ack)).statusCode, 409);
  } finally { await app.close(); }
});

test("postcommit subscriber failure preserves the command and delivery to other subscribers", async () => {
  const { app, agent, store } = fixture(null);
  try {
    store.create("s1");
    let received = false;
    store.subscribe("s1", () => { throw new Error("subscriber down"); });
    store.subscribe("s1", (event) => { if (event.type === "playback.command") received = true; });
    await agent.control({ action: "pause", expectedPlaybackVersion: 0 }, "s1", "manual:pause");
    assert.equal(store.read("s1").desiredPlayback, "pause");
    assert.equal(store.read("s1").command?.action, "pause");
    assert.equal(received, true);
  } finally { await app.close(); }
});

test("mock music: scenario search, unknown title, actual WAV and byte-range responses", async () => {
  const music = new MockMusic("http://127.0.0.1:8081");
  const signal = new AbortController().signal;
  const quiet = await music.search("安静 工作 专注", 3, signal);
  const energetic = await music.search("high 动感 下班", 3, signal);
  assert.equal(quiet.length, 3);
  assert.equal(energetic.length, 3);
  assert.ok(quiet.every((t) => t.id.startsWith("mock:focus")));
  assert.ok(energetic.every((t) => t.id.startsWith("mock:energy")));
  assert.deepEqual(await music.search("a_song_not_in_the_catalog", 5, signal), []);
  const resource = await music.inspect(quiet[0], signal);
  assert.equal(resource.availability, "full");
  const { app } = makeApp({
    databasePath: ":memory:", music, model: null, modelName: null, musicProvider: "mock",
  });
  try {
    const url = new URL(resource.url!).pathname;
    const audio = await app.inject({ method: "GET", url });
    assert.equal(audio.statusCode, 200);
    assert.equal(audio.rawPayload.toString("ascii", 0, 4), "RIFF");
    assert.equal(audio.rawPayload.readUInt32LE(40), 24 * 16000 * 2);
    const range = await app.inject({ method: "GET", url, headers: { range: "bytes=0-43" } });
    assert.equal(range.statusCode, 206);
    assert.equal(range.rawPayload.length, 44);
    assert.equal((await app.inject({ method: "GET", url, headers: { range: "bytes=9999999-" } })).statusCode, 416);
    assert.equal((await app.inject({ method: "GET", url: "/api/lab/health" })).json().musicProvider, "mock");
  } finally { await app.close(); }
});

class ScriptModel extends BaseChatModel {
  index = 0;
  seen: BaseMessage[][] = [];
  constructor(private steps: ((messages: BaseMessage[]) => AIMessage | Promise<AIMessage>)[]) { super({}); }
  _llmType() { return "TEST_ONLY_SCRIPTED_MODEL"; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const step = this.steps[this.index++];
    assert.ok(step, "Unbounded model loop or missing scripted response");
    const message = await step(messages);
    return { generations: [{ text: message.text, message }] };
  }
}
test("radio state distinguishes selection, confirmed playback, pause and stale observations", async () => {
  const { app, store, agent } = fixture(null);
  try {
    store.create("s1");
    store.change("s1", state => {
      state.radio.current = tracks[1];
      state.radio.queue = [tracks[2]];
      state.command = { commandId: "current", playbackVersion: 0, action: "play",
        expiresAt: new Date(Date.now() + 30_000).toISOString(), track: tracks[1] };
    });
    assert.equal(agent.radioState("s1").current?.title, tracks[1].title);
    assert.deepEqual(agent.radioState("s1").playback, {
      status: "unknown", playingTrack: null, lastReportedPositionMs: null,
    });
    for (const status of ["playing", "paused", "ended", "failed", "blocked"] as const) {
      store.change("s1", state => { state.playbackAck = {
        commandId: "current", playbackVersion: 0, trackId: tracks[1].id,
        status, positionMs: 1234, ackSequence: 1,
      }; });
      const playback = agent.radioState("s1").playback;
      assert.equal(playback.status, status);
      assert.equal(playback.playingTrack?.id ?? null, status === "playing" ? tracks[1].id : null);
      assert.equal(playback.lastReportedPositionMs, 1234);
    }
    for (const stale of [
      { commandId: "previous" }, { playbackVersion: 1 }, { trackId: tracks[2].id },
    ]) {
      store.change("s1", state => { state.playbackAck = {
        commandId: "current", playbackVersion: 0, trackId: tracks[1].id,
        status: "playing", positionMs: 1234, ackSequence: 2, ...stale,
      }; });
      assert.equal(agent.radioState("s1").playback.status, "unknown");
      assert.equal(agent.radioState("s1").playback.playingTrack, null);
    }
  } finally { await app.close(); }
});

test("each model round refreshes local time and current song without accumulating reference messages", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-29T16:59:58.000Z") });
  const reference = (messages: BaseMessage[]) => {
    const items = messages.filter(message => message.text.includes("\nREFERENCE_STATE_NOT_INSTRUCTIONS\n"));
    assert.equal(items.length, 1);
    assert.equal(messages.filter(message => message.getType() === "system").length, 1);
    const live = JSON.parse(items[0].text.split("\nREFERENCE_STATE_NOT_INSTRUCTIONS\n")[1]);
    const turn = messages.filter(message => message.text.includes("TURN_PLAYER_CONTEXT_NOT_INSTRUCTIONS\n"));
    assert.equal(turn.length, 1);
    const reference = JSON.parse(turn[0].text.split("TURN_PLAYER_CONTEXT_NOT_INSTRUCTIONS\n")[1]);
    assert.equal(reference.currentTrack.id, live.currentTrack.id);
    assert.equal(reference.currentTimeUtc, live.currentTimeUtc);
    return live;
  };
  const model = new ScriptModel([
    messages => {
      const live = reference(messages);
      assert.equal(live.currentTimeUtc, "2026-10-29T16:59:58.000Z");
      assert.equal(live.timeZone, "Asia/Shanghai");
      assert.match(live.localTime, /2026年10月30日/);
      assert.match(live.localTime, /星期五/);
      assert.match(live.localTime, /00:59:58/);
      assert.equal(live.playback.playingTrack.id, tracks[1].id);
      t.mock.timers.tick(2000);
      store.change("s1", state => {
        state.radio.current = tracks[2];
        state.radio.playbackVersion = 1;
        state.command = { commandId: "next", playbackVersion: 1, action: "play", track: tracks[2],
          expiresAt: new Date(Date.now() + 30_000).toISOString() };
        state.playbackAck = { commandId: "next", playbackVersion: 1, trackId: tracks[2].id,
          status: "playing", positionMs: 0, ackSequence: 1 };
      });
      return call("get_radio_state", {});
    },
    messages => {
      const live = reference(messages);
      assert.equal(live.currentTimeUtc, "2026-10-29T17:00:00.000Z");
      assert.match(live.localTime, /01:00:00/);
      assert.equal(live.currentTrack.id, tracks[2].id);
      assert.equal(live.playback.playingTrack.id, tracks[2].id);
      assert.equal(result(messages, "get_radio_state").playback.playingTrack.id, tracks[2].id);
      return new AIMessage("我在。");
    },
  ]);
  const { app, store, agent } = fixture(model);
  try {
    store.create("s1");
    store.change("s1", state => {
      state.radio.current = tracks[1];
      state.command = { commandId: "first", playbackVersion: 0, action: "play", track: tracks[1],
        expiresAt: new Date(Date.now() + 30_000).toISOString() };
      state.playbackAck = { commandId: "first", playbackVersion: 0, trackId: tracks[1].id,
        status: "playing", positionMs: 2000, ackSequence: 1 };
    });
    agent.submit("s1", message("live-context", "现在放的是哪首？"));
    await agent.idle();
    assert.equal(model.index, 2);
    assert.equal(store.read("s1").runs[0].status, "completed");
    const contexts = store.replay("s1", 0).filter(event => event.type === "model.context");
    assert.deepEqual(contexts.map(event => event.payload.playingTrack?.id), [tracks[1].id, tracks[2].id]);
    assert.deepEqual(contexts.map(event => event.payload.currentTimeUtc),
      ["2026-10-29T16:59:58.000Z", "2026-10-29T17:00:00.000Z"]);
    const checkpoint = await agent.graph!.getState({ configurable: { thread_id: "s1:0" } }) as {
      values: { messages: BaseMessage[] };
    };
    assert.ok(checkpoint.values.messages.every(message =>
      !message.text.includes("TURN_PLAYER_CONTEXT_NOT_INSTRUCTIONS")));
    assert.equal(store.read("s1").messages.find(message => message.role === "user")?.text, "现在放的是哪首？");
  } finally { await app.close(); t.mock.timers.reset(); }
});

for (const scenario of [
  { query: "现在是什么歌", current: { id: "easy-living", title: "Easy Living", artist: "Bill Evans", album: "Conception" } },
  { query: "这个歌手好像很熟悉，是不是唱过一首home?", current: {
    id: "quando", title: "Quando, Quando, Quando (with Nelly Furtado)", artist: "Michael Bublé, Nelly Furtado", album: "It's Time",
  } },
]) test(`DeepSeek wire request grounds "${scenario.query}" without an ACK despite stale chat`, async () => {
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const model = new ChatDeepSeek({ apiKey: "fixture-not-a-real-key", model: "deepseek-flash", maxRetries: 0,
    configuration: { fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "fixture", object: "chat.completion", created: 1,
        model: "deepseek-flash", choices: [{ index: 0, finish_reason: "stop",
          message: { role: "assistant", content: "Bill Evans 的《Easy Living》。" } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }),
      { headers: { "Content-Type": "application/json" } });
    } },
  });
  const { app, store, agent } = fixture(model);
  try {
    store.create("s1");
    const current: Track = scenario.current;
    store.change("s1", state => {
      state.rebuildThread = true;
      state.messages = [{ id: "old-user", role: "user", text: "现在是什么歌", status: "saved",
        createdAt: new Date().toISOString() }, { id: "old-reply", role: "assistant", source: "model",
        text: "还是《Almost Blue》，Chet Baker。不能算亲耳确认。", status: "complete", createdAt: new Date().toISOString() }];
      state.radio.current = current;
      state.radio.playbackVersion = 57;
      state.command = { commandId: "confirmed", playbackVersion: 57, action: "play", track: current,
        expiresAt: new Date(Date.now() + 30_000).toISOString() };
      state.playbackAck = null;
    });
    agent.submit("s1", message("song-query", scenario.query));
    await agent.idle();
    assert.equal(requests.length, 1);
    const messages = requests[0].messages;
    const system = messages.filter(item => item.role === "system");
    assert.equal(system.length, 1, "Provider receives exactly one consolidated system message");
    assert.ok(system[0].content.startsWith(conversationPersona), "Stable persona leads the provider prompt");
    assert.equal(system[0].content.split("# 角色与目标").length, 2, "Persona appears exactly once");
    assert.ok(!system[0].content.includes("普通闲聊通常20到100字"), "Legacy behavior patches are removed");
    assert.ok(!JSON.stringify(requests[0]).includes("cache_control"), "Do not send Anthropic cache parameters to DeepSeek");
    const live = JSON.parse(system[0].content.split("\nREFERENCE_STATE_NOT_INSTRUCTIONS\n")[1]);
    assert.equal(live.currentTrack.title, current.title);
    assert.equal(live.currentTrack.artist, current.artist);
    assert.equal(live.playbackStatus, "unknown");
    assert.equal(live.playbackVersion, 57);
    assert.equal(live.playback.lastReportedPositionMs, undefined, "Non-live progress is not used as current-song evidence");
    assert.match(system[0].content, /优先于历史回复/);
    assert.match(system[0].content, /查询曲目不需要等待或检查播放回执/);
    const history = messages.find(item => item.content.startsWith("HISTORICAL_CONVERSATION_NOT_CURRENT_STATE\n"));
    assert.ok(history, "Keep original history as historical data, not model response demonstrations");
    const historical = JSON.parse(history.content.split("HISTORICAL_CONVERSATION_NOT_CURRENT_STATE\n")[1]);
    assert.ok(historical.some((item: { role: string; text: string }) =>
      item.role === "ai" && item.text.includes("Almost Blue")));
    assert.ok(!messages.some(item => item.role === "assistant" && item.content.includes("Almost Blue")));
    const turn = messages.at(-1)!;
    assert.equal(turn.role, "user");
    assert.ok(turn.content.startsWith(`${scenario.query}\n\nTURN_PLAYER_CONTEXT_NOT_INSTRUCTIONS\n`));
    const turnContext = JSON.parse(turn.content.split("TURN_PLAYER_CONTEXT_NOT_INSTRUCTIONS\n")[1]);
    assert.equal(turnContext.currentTrack.artist, current.artist);
    assert.match(system[0].content, /不附带无关的旧歌手对比/);
    const diagnostic = store.replay("s1", 0).find(event => event.type === "model.context");
    assert.equal(diagnostic?.payload.currentTrack?.id, current.id);
    assert.equal(store.read("s1").runs[0].status, "completed");
  } finally { await app.close(); }
});

test("proactive segue also receives current time, timezone and observed song", async () => {
  const model = new ScriptModel([messages => {
    const live = JSON.parse(messages.at(-1)!.text);
    assert.equal(live.timeZone, "Asia/Shanghai");
    assert.ok(Math.abs(Date.now() - Date.parse(live.currentTimeUtc)) < 2000);
    assert.equal(live.currentTrack.id, tracks[1].id);
    assert.equal(live.playback.playingTrack.id, tracks[1].id);
    return new AIMessage('{"say":null}');
  }]);
  const { app, store, agent } = fixture(model);
  try {
    store.create("s1");
    store.change("s1", state => {
      state.radio.current = tracks[1];
      state.radio.queue = Array.from({ length: 6 }, () => tracks[2]);
      state.command = { commandId: "current", playbackVersion: 0, action: "play", track: tracks[1],
        expiresAt: new Date(Date.now() + 30_000).toISOString() };
      state.playbackAck = { commandId: "current", playbackVersion: 0, trackId: tracks[1].id,
        status: "playing", positionMs: 1000, ackSequence: 1 };
      state.maintenance.endedCount = 2;
    });
    await agent.maintain("s1");
    await agent.idle();
    assert.equal(model.index, 1);
  } finally { await app.close(); }
});

for (const configured of [true, false]) {
  test(`agent gets current system speech capability on every turn: configured=${configured}`, async () => {
    const model = new ScriptModel([false, true].map((enabled) => (messages: BaseMessage[]) => {
      const system = messages.filter((m) => m.getType() === "system").map((m) => m.text).join("\n");
      assert.ok(system.includes(configured ? "当前产品已接入语音合成服务" : "语音合成服务尚未配置"));
      if (configured) assert.ok(system.includes(enabled ? "自动播报开关已开启" : "自动播报开关已关闭"));
      assert.ok(!system.includes("没有长期记忆或TTS工具"));
      return new AIMessage("收到。");
    }));
    const { app, store, agent } = makeApp({ databasePath: ":memory:", music: fixtureMusic(), model,
      modelName: "test", speech: configured ? { async synthesize() { throw new Error("not used"); } } : undefined });
    try {
      store.create("s1");
      for (const enabled of [false, true]) {
        store.change("s1", (state) => { state.settings.autoSpeech = enabled; });
        agent.submit("s1", message(`speech-${enabled}`, "你支持语音播报吗？"));
        await agent.idle();
        assert.equal(agent.radioState("s1").speech.available, configured);
        assert.equal(agent.radioState("s1").speech.autoSpeech, enabled);
      }
      assert.equal(model.index, 2);
      assert.equal(store.read("s1").runs.every((run) => run.status === "completed"), true);
    } finally { await app.close(); }
  });
}
test("Six action rounds reserve a final reply after a confirmed playback action, and reset next run", async () => {
  const model = new ScriptModel([
    ...Array.from({ length: 5 }, (_, i) => () => call("get_radio_state", {}, `read_${i}`)),
    () => call("control_playback", { action: "pause", expectedPlaybackVersion: 0 }),
    (messages) => {
      assert.equal(result(messages, "control_playback").playbackOutcome, "paused");
      assert.ok(messages.some((m) => m.text.includes("现在只生成最终回复")));
      return new AIMessage("已暂停。");
    },
    (messages) => {
      assert.ok(!messages.some((m) => m.text.includes("现在只生成最终回复")));
      return call("get_radio_state", {}, "next_run");
    },
    () => new AIMessage("第二轮正常。"),
  ]);
  const { app, agent, store } = fixture(model);
  try {
    store.create("s1");
    store.change("s1", (state) => { state.radio.current = tracks[1]; });
    const pending: Promise<unknown>[] = [];
    const unsubscribe = store.subscribe("s1", (event) => {
      if (event.type === "playback.command") pending.push(post(app, "/api/lab/sessions/s1/playback/acks", {
        commandId: event.payload.commandId, playbackVersion: event.payload.playbackVersion,
        ackSequence: 1, status: "paused", positionMs: 0,
      }));
    });
    await post(app, "/api/lab/sessions/s1/messages", message());
    await agent.idle();
    await Promise.all(pending);
    unsubscribe();
    assert.equal(model.index, 7);
    assert.equal(store.read("s1").runs[0].status, "completed");
    assert.equal(store.replay("s1", 0).filter((e) => e.type === "playback.command").length, 1);
    await post(app, "/api/lab/sessions/s1/messages", message("r2", "现在什么状态"));
    await agent.idle();
    assert.equal(store.read("s1").runs[1].status, "completed");
    assert.equal(model.index, 9);
  } finally { await app.close(); }
});

test("Tool budget also forces a final reply before another action round", async () => {
  const model = new ScriptModel([
    () => new AIMessage({ content: "", tool_calls: Array.from({ length: 12 }, (_, i) => ({
      id: `read_${i}`, name: "get_radio_state", args: {},
    })) }),
    (messages) => {
      assert.ok(messages.some((m) => m.text.includes("现在只生成最终回复")));
      return new AIMessage("本轮没有更改播放。");
    },
  ]);
  const { app, agent, store } = fixture(model);
  try {
    store.create("s1");
    await post(app, "/api/lab/sessions/s1/messages", message());
    await agent.idle();
    assert.equal(store.read("s1").runs[0].status, "completed");
    assert.equal(model.index, 2);
  } finally { await app.close(); }
});

test("Model failure after a committed action preserves it and gives one factual fallback without a failure alert", async () => {
  const model = new ScriptModel([
    () => call("control_playback", { action: "pause", expectedPlaybackVersion: 0 }),
    () => { throw new Error("SECRET_UPSTREAM_DETAIL"); },
  ]);
  const { app, agent, store } = fixture(model);
  try {
    store.create("s1");
    store.change("s1", (state) => { state.radio.current = tracks[1]; });
    await post(app, "/api/lab/sessions/s1/messages", message());
    await agent.idle();
    const events = store.replay("s1", 0);
    const failure = events.find((e) => e.type === "run.partial");
    assert.ok(failure && failure.type === "run.partial");
    assert.equal(failure.payload.code, "MODEL_CALL_FAILED");
    assert.equal(failure.payload.actionsCommitted, true);
    assert.ok(failure.payload.message?.includes("已提交"));
    assert.equal(failure.payload.incident?.visibility, "inline");
    assert.equal(failure.payload.incident?.recovery, "none");
    assert.equal(store.read("s1").runs[0].status, "partial");
    assert.equal(store.read("s1").runs[0].replySource, "fallback");
    assert.equal(events.filter((e) => e.type === "reply.final").length, 1);
    assert.equal(events.filter((e) => e.type === "playback.command").length, 1);
    assert.ok(!JSON.stringify(failure).includes("SECRET_UPSTREAM_DETAIL"));
    assert.equal(store.read("s1").command?.action, "pause");
  } finally { await app.close(); }
});

test("A model ignoring the final-only constraint cannot execute another tool", async () => {
  const model = new ScriptModel(Array.from({ length: 7 }, (_, i) =>
    () => call("get_radio_state", {}, `read_${i}`)));
  const { app, agent, store } = fixture(model);
  try {
    store.create("s1");
    await post(app, "/api/lab/sessions/s1/messages", message());
    await agent.idle();
    const events = store.replay("s1", 0);
    assert.equal(events.filter((e) => e.type === "agent.activity" && e.payload.phase === "started").length, 6);
    const failure = events.find((e) => e.type === "run.failed");
    assert.ok(failure && failure.type === "run.failed");
    assert.equal(failure.payload.code, "FINAL_REPLY_REQUIRED");
    assert.equal(model.index, 7);
  } finally { await app.close(); }
});

for (const observation of ["playing", "paused", "blocked", "failed", "superseded"] as const) {
  test(`Fallback uses committed facts and notification level: ${observation}`, async () => {
    const model = new ScriptModel([
      () => call("control_playback", { action: observation === "paused" ? "pause" : "play",
        expectedPlaybackVersion: 0 }),
      () => { throw new Error("PRIVATE_PROVIDER_RESPONSE"); },
      (messages) => {
        assert.ok(!messages.some(isToolMessage), "Interrupted tools must not be replayed");
        return new AIMessage("下一轮正常。");
      },
    ]);
    const { app, store, agent } = fixture(model);
    const pending: Promise<unknown>[] = [];
    try {
      store.create("s1");
      store.change("s1", (state) => { state.radio.current = tracks[1]; });
      const unsubscribe = store.subscribe("s1", (event) => {
        if (event.type !== "playback.command" || event.requestId !== "r1") return;
        if (observation === "superseded") {
          pending.push(agent.control({ action: "pause", expectedPlaybackVersion: 1 }, "s1", "manual:newer"));
        } else {
          pending.push(post(app, "/api/lab/sessions/s1/playback/acks", {
            commandId: event.payload.commandId, playbackVersion: event.payload.playbackVersion,
            ackSequence: 1, trackId: tracks[1].id, status: observation, positionMs: 0,
          }));
        }
      });
      await post(app, "/api/lab/sessions/s1/messages", message());
      await agent.idle();
      await Promise.all(pending);
      unsubscribe();
      const events = store.replay("s1", 0);
      const terminal = events.find((e) => e.type === "run.partial");
      assert.ok(terminal && terminal.type === "run.partial");
      assert.equal(terminal.payload.replySource, "fallback");
      assert.equal(terminal.payload.incident?.level,
        ["blocked", "failed"].includes(observation) ? "action_required" : "degraded");
      assert.equal(terminal.payload.incident?.visibility, observation === "blocked" ? "banner" : "inline");
      const text = store.read("s1").messages.at(-1)!.text;
      assert.ok(text.includes({
        playing: "确认开始播放", paused: "确认暂停", blocked: "点击播放",
        failed: "没有成功播放", superseded: "新变化",
      }[observation]));
      assert.equal(store.read("s1").runs[0].actions?.length, 1);
      assert.equal(events.filter((e) => e.type === "reply.final").length, 1);
      assert.ok(!JSON.stringify(events).includes("PRIVATE_PROVIDER_RESPONSE"));
      const before = events.filter((e) => e.type === "playback.command").length;
      await post(app, "/api/lab/sessions/s1/messages", message());
      await agent.idle();
      assert.equal(model.index, 2, "Duplicate request must not restart a partial task");
      assert.equal(store.replay("s1", 0).filter((e) => e.type === "playback.command").length, before);
      await post(app, "/api/lab/sessions/s1/messages", message("r2", "你好"));
      await agent.idle();
      assert.equal(store.read("s1").runs[1].status, "completed");
    } finally { await app.close(); }
  });
}

test("Queue-only commit gives an accurate fallback without claiming immediate playback", async () => {
  const model = new ScriptModel([
    () => call("update_music_queue", { candidateIds: ["candidate"], mode: "replace",
      timing: "after_current", expectedQueueVersion: 0 }),
    () => { throw new Error("PRIVATE_DETAILS"); },
  ]);
  const { app, store, agent } = fixture(model);
  try {
    store.create("s1");
    store.change("s1", (state) => {
      state.radio.current = tracks[1];
      state.candidates = [{ id: "candidate", requestId: "r1", track: tracks[2],
        resource: { availability: "full", reason: "fixture", expiresAt: Date.now() + 60_000,
          url: "http://127.0.0.1:9876/fixture.wav" } }];
    });
    await post(app, "/api/lab/sessions/s1/messages", message());
    await agent.idle();
    assert.equal(store.read("s1").runs[0].status, "partial");
    assert.match(store.read("s1").messages.at(-1)!.text, /没有立即切换/);
    assert.equal(store.replay("s1", 0).filter((e) => e.type === "playback.command").length, 0);
  } finally { await app.close(); }
});

test("Balance failure without a committed action gives actionable feedback and no invented success", async () => {
  const model = new ScriptModel([() => { throw Object.assign(new Error("SECRET"), { status: 402 }); }]);
  const { app, store, agent } = fixture(model);
  try {
    store.create("s1");
    await post(app, "/api/lab/sessions/s1/messages", message());
    await agent.idle();
    const events = store.replay("s1", 0);
    const terminal = events.find((e) => e.type === "run.failed");
    assert.ok(terminal && terminal.type === "run.failed");
    assert.equal(terminal.payload.code, "MODEL_BALANCE");
    assert.equal(terminal.payload.actionsCommitted, false);
    assert.equal(terminal.payload.incident?.recovery, "configure");
    assert.equal(terminal.payload.incident?.visibility, "banner");
    assert.equal(events.filter((e) => e.type === "reply.final").length, 1);
    assert.match(store.read("s1").messages.at(-1)!.text, /没有提交新的/);
    assert.ok(!JSON.stringify(events).includes("SECRET"));
  } finally { await app.close(); }
});

test("Structured provider status is classified without exposing messages", () => {
  for (const [status, expected] of [
    [401, "MODEL_AUTH_FAILED"], [402, "MODEL_BALANCE"], [429, "MODEL_RATE_LIMITED"],
    [422, "MODEL_PROTOCOL_ERROR"], [503, "MODEL_UNAVAILABLE"],
  ] as const) {
    assert.equal(classifyFailure(new Error("wrapper", {
      cause: Object.assign(new Error("private"), { status }),
    })), expected);
  }
  assert.equal(classifyFailure(Object.assign(new Error("private"), { name: "APIConnectionTimeoutError" })), "RUN_TIMEOUT");
});

const call = (name: string, args: Record<string, unknown>, id = name) =>
  new AIMessage({ content: "INTERNAL_TEXT_MUST_NOT_BE_PUBLISHED", tool_calls: [{ id, name, args }] });
function result(messages: BaseMessage[], name: string) {
  const message = [...messages].reverse().find((m) => isToolMessage(m) && m.name === name);
  assert.ok(message, `Missing tool result for ${name}`);
  return JSON.parse(message.text);
}
const tracks: Track[] = [
  { id: "t_preview", title: "Test preview", artist: "Fixture", durationMs: 180_000 },
  { id: "t_full", title: "Test full", artist: "Fixture", durationMs: 180_000 },
  { id: "t_other", title: "Test other", artist: "Fixture", durationMs: 180_000 },
];
function fixtureMusic(): Music {
  return {
    async search(_, limit) { return structuredClone(tracks.slice(0, limit)); },
    async inspect(track) {
      return {
        availability: track.id === "t_preview" ? "preview_only" : "unknown",
        url: track.id === "t_preview" ? undefined : `http://127.0.0.1:9876/${track.id}.wav`,
        reason: track.id === "t_preview" ? "TRIAL_OR_SHORT_RESOURCE" : "ACK_REQUIRED",
        expiresAt: Date.now() + 120_000,
      };
    },
  };
}
function fixture(model: BaseChatModel | null, databasePath = ":memory:") {
  return makeApp({ model, databasePath, modelName: model ? "test-only" : null, music: fixtureMusic(), ackTimeoutMs: 30 });
}
test("Agent learns a structured preference and the next recommendation produces personalized cards without playback", async () => {
  const model = new ScriptModel([
    messages => {
      const system = messages.find(message => message.text.includes("REFERENCE_STATE_NOT_INSTRUCTIONS"))!.text;
      const reference = JSON.parse(system.split("REFERENCE_STATE_NOT_INSTRUCTIONS\n").at(-1)!);
      return call("propose_memory_update", { items: [{
        text: "喜欢Fixture", kind: "preference", scope: "general", certainty: "explicit",
        sourceIds: [reference.currentUserEvidence.id],
        preference: { dimension: "artist", value: "Fixture", polarity: "like" },
      }] });
    },
    messages => {
      assert.equal(result(messages, "propose_memory_update").ok, true);
      return new AIMessage("他们的作品你最常听哪首？");
    },
    messages => {
      assert.ok(messages.some(message => message.text.includes('"value":"Fixture"')));
      return call("recommend_music", { purpose: "cards", queries: ["quiet"], limit: 2 });
    },
    messages => call("send_message", { text: "这两首试试。", candidateIds:
      result(messages, "recommend_music").candidates.map((candidate: any) => candidate.candidateId) }),
    () => new AIMessage("REPLY_DELIVERED"),
  ]);
  const { app, store, agent } = fixture(model);
  try {
    store.create("s1");
    agent.submit("s1", { requestId: "learn", clientMessageId: "learn", text: "我很喜欢Fixture的歌" });
    await agent.idle();
    assert.equal(store.read("s1").runs[0].status, "completed");
    assert.equal(agent.knowledge.profile()[0].value, "Fixture");
    agent.submit("s1", { requestId: "recommend", clientMessageId: "recommend", text: "推荐两首吧" });
    await agent.idle();
    const state = store.read("s1");
    assert.equal(state.runs[1].status, "completed");
    assert.equal(state.messages.at(-1)?.tracks?.length, 2);
    assert.equal(state.command, null);
    assert.equal(state.radio.queue.length, 0);
    assert.ok(agent.recommendation.traces("s1")[0].selected.every((item: any) => item.reasons.includes("profile_match")));
  } finally { await app.close(); }
});

test("chat forgetting completes its own request, invalidates other old contexts and rebuilds the next turn", async () => {
  let targetId = "";
  const model = new ScriptModel([
    () => call("request_memory_change", { operation: "forget", targetId, text: "忘记Fixture", scope: "general" }),
    messages => {
      assert.equal(result(messages, "request_memory_change").ok, true);
      return new AIMessage("好，已经忘记这条偏好。");
    },
    messages => {
      assert.ok(!messages.some(message => message.text.includes("喜欢Fixture")));
      return new AIMessage("现在没有保存的音乐偏好。");
    },
  ]);
  const { app, store, agent } = fixture(model);
  try {
    store.create("s1");
    agent.knowledge.archive("s1", { id: "old", role: "user", text: "喜欢Fixture", status: "saved", createdAt: "2026-10-20T00:00:00.000Z" });
    targetId = agent.knowledge.save({ text: "喜欢Fixture", kind: "preference", scope: "general",
      certainty: "explicit", sourceIds: ["old"], preference: { dimension: "artist", value: "Fixture", polarity: "like" } }).id;
    agent.submit("s1", { requestId: "forget", clientMessageId: "forget", text: "把对Fixture的偏好忘掉" });
    await agent.idle();
    assert.equal(store.read("s1").runs[0].status, "completed");
    assert.equal(agent.knowledge.profile().length, 0);
    assert.equal(store.read("s1").rebuildThread, true);
    assert.throws(() => agent.assertLive({ sessionId: "s1", requestId: "old-request", memoryRevision: 0 }), /CONTEXT_CHANGED/);
    agent.submit("s1", { requestId: "after", clientMessageId: "after", text: "还记得我哪些音乐偏好" });
    await agent.idle();
    assert.equal(store.read("s1").runs[1].status, "completed");
    assert.equal(store.read("s1").rebuildThread, false);
  } finally { await app.close(); }
});

test("recommendations publish real cards and multiple messages without touching playback or queue", async () => {
  const model = new ScriptModel([
    (messages) => {
      assert.match(messages.at(-1)!.text, /^推荐几首晚上干活的歌\n\nTURN_PLAYER_CONTEXT_NOT_INSTRUCTIONS\n/);
      assert.ok(messages[0].text.includes("闲聊"));
      return call("search_music", { query: "quiet", limit: 3 });
    },
    (messages) => call("send_message", { text: "这几首给你挑着听。",
      candidateIds: result(messages, "search_music").candidates.slice(1).map((c: any) => c.candidateId) }, "cards"),
    () => call("send_message", { text: "你更喜欢有人唱的，还是纯音乐？", candidateIds: [] }, "followup"),
    () => new AIMessage("REPLY_DELIVERED"),
  ]);
  const { app, store, agent } = fixture(model);
  try {
    store.create("s1");
    store.change("s1", (s) => { s.radio.current = tracks[1]; s.radio.queue = [tracks[2]]; });
    const before = store.read("s1").radio;
    agent.submit("s1", { clientMessageId: "cards", requestId: "cards", text: "推荐几首晚上干活的歌" });
    await agent.idle();
    const state = store.read("s1");
    assert.deepEqual(state.radio, before);
    assert.equal(state.command, null);
    assert.equal(state.messages.length, 3);
    assert.deepEqual(state.messages[1].tracks?.map((t) => t.id), tracks.slice(1).map((t) => t.id));
    assert.equal(state.messages[2].text, "你更喜欢有人唱的，还是纯音乐？");
    assert.equal(state.runs[0].status, "completed");
    assert.equal(store.replay("s1", 0).filter((e) => e.type === "reply.final").length, 2);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM lab_archive").get() as { n: number }).n, 3);
  } finally { await app.close(); }
});

test("message tool rejects fabricated candidates and bounds repeated messages", async () => {
  const model = new ScriptModel([
    () => call("send_message", { text: "不能凭空造卡片", candidateIds: ["fake"] }, "fake"),
    (messages) => {
      assert.equal(result(messages, "send_message").code, "CANDIDATE_NOT_IN_THIS_REQUEST");
      return call("send_message", { text: "第一条" }, "one");
    },
    () => call("send_message", { text: "第二条" }, "two"),
    () => call("send_message", { text: "第三条" }, "three"),
    () => call("send_message", { text: "第四条" }, "four"),
    (messages) => {
      assert.equal(result(messages, "send_message").code, "MESSAGE_LIMIT");
      return new AIMessage("REPLY_DELIVERED");
    },
  ]);
  const { app, agent, store } = fixture(model);
  try {
    store.create("s1");
    agent.submit("s1", { clientMessageId: "bounded", requestId: "bounded", text: "聊聊" });
    await agent.idle();
    assert.deepEqual(store.read("s1").messages.filter((m) => m.role === "assistant").map((m) => m.text),
      ["第一条", "第二条", "第三条"]);
  } finally { await app.close(); }
});

test("a recent direct reply suppresses proactive follow-ups even when several previews ended", async () => {
  const model = new ScriptModel([() => new AIMessage('{"say":null}')]);
  const { app, agent, store } = fixture(model);
  try {
    store.create("s1");
    store.change("s1", (state) => {
      state.radio.current = tracks[1];
      state.radio.queue = Array.from({ length: 6 }, () => tracks[2]);
      state.playbackAck = { commandId: "playing", playbackVersion: 0, ackSequence: 1, status: "playing", positionMs: 0 };
      state.maintenance.endedCount = 8;
      state.messages.push({ id: "recent", role: "assistant", source: "model", text: "我也更喜欢那一版。",
        status: "complete", createdAt: new Date(Date.now() - 30_000).toISOString() });
    });
    await agent.maintain("s1"); await agent.idle();
    assert.equal(model.index, 0);
    store.change("s1", (state) => { state.messages[0].createdAt = new Date(Date.now() - 100_000).toISOString(); });
    await agent.maintain("s1"); await agent.idle();
    assert.equal(model.index, 1);
  } finally { await app.close(); }
});

test("a provider failure after a visible message preserves it as a partial reply", async () => {
  const model = new ScriptModel([
    () => call("send_message", { text: "我更喜欢他那几首吉他伴奏的歌。" }),
    () => { throw Object.assign(new Error("provider"), { status: 402 }); },
  ]);
  const { app, agent, store } = fixture(model);
  try {
    store.create("s1");
    agent.submit("s1", { clientMessageId: "partial-chat", requestId: "partial-chat", text: "聊聊Daniel Caesar" });
    await agent.idle();
    const state = store.read("s1");
    assert.equal(state.runs[0].status, "partial");
    assert.equal(state.messages[1].text, "我更喜欢他那几首吉他伴奏的歌。");
    assert.ok(state.messages.at(-1)?.text.includes("余额不足"));
    assert.ok(!state.messages.at(-1)?.text.includes("队列"));
  } finally { await app.close(); }
});
const message = (requestId = "r1", text = "工作时放点安静的音乐") => ({
  clientMessageId: `m_${requestId}`, requestId, text,
});
async function post(app: ReturnType<typeof makeApp>["app"], url: string, payload: unknown) {
  return app.inject({ method: "POST", url, payload: payload as object });
}

for (const outcome of ["playing", "paused", "failed", "blocked", "pending", "superseded", "cancelled"] as const) {
  test(`Agent consumes browser result: ${outcome}`, async () => {
    let modelContinued = false;
    const model = new ScriptModel([
      () => call("control_playback", { action: outcome === "paused" ? "pause" : "play", expectedPlaybackVersion: 0 }),
      (messages) => {
        const observed = result(messages, "control_playback");
        assert.equal(observed.playbackOutcome, outcome);
        assert.equal(observed.playbackConfirmed, outcome === "playing");
        modelContinued = true;
        return new AIMessage(`Observed ${outcome}`);
      },
    ]);
    const { app, agent, store } = makeApp({
      model, modelName: "test-only", databasePath: ":memory:", music: fixtureMusic(), ackTimeoutMs: 60,
    });
    const pending: Promise<unknown>[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      store.create("s1");
      store.change("s1", (state) => { state.radio.current = tracks[1]; });
      const unsubscribe = store.subscribe("s1", (event) => {
        if (event.type !== "playback.command" || outcome === "pending") return;
        assert.equal(modelContinued, false, "Model must wait for browser result");
        timer = setTimeout(() => {
          if (outcome === "cancelled") { agent.cancel("s1", "r1"); return; }
          if (outcome === "superseded") {
            pending.push(agent.control({ action: "pause", expectedPlaybackVersion: 1 }, "s1", "manual:newer"));
            return;
          }
          pending.push(post(app, "/api/lab/sessions/s1/playback/acks", {
            commandId: event.payload.commandId, playbackVersion: event.payload.playbackVersion,
            ackSequence: 1, trackId: tracks[1].id, status: outcome, positionMs: 0,
          }).then((response) => assert.equal(response.statusCode, 200)));
        }, 5);
      });
      // Only react to the Agent command, not the newer manual command.
      const originalControl = agent.control.bind(agent);
      agent.control = async (...args) => {
        if (args[2] === "manual:newer") unsubscribe();
        return originalControl(...args);
      };
      await post(app, "/api/lab/sessions/s1/messages", message());
      await agent.idle();
      await Promise.all(pending);
      unsubscribe();
      assert.equal(store.read("s1").runs[0].status, outcome === "cancelled" ? "cancelled" : "completed");
      assert.equal(modelContinued, outcome !== "cancelled");
      if (outcome === "pending") {
        const command = store.read("s1").command!;
        const ack = { commandId: command.commandId, playbackVersion: command.playbackVersion,
          ackSequence: 2, trackId: tracks[1].id, status: "playing", positionMs: 0 };
        assert.equal((await post(app, "/api/lab/sessions/s1/playback/acks", ack)).statusCode, 200);
        assert.equal(model.index, 2, "Late ACK must not start another model run");
        await post(app, "/api/lab/sessions/s1/playback/acks", { ...ack, ackSequence: 1, status: "failed" });
        assert.equal(store.read("s1").playbackAck?.status, "playing", "Older ACK sequence cannot overwrite newer observation");
      }
    } finally {
      clearTimeout(timer);
      await app.close();
    }
  });
}

test("pending playback is reused and a late success completes the original command without another model run", async () => {
  const model = new ScriptModel([
    () => call("control_playback", { action: "play", expectedPlaybackVersion: 0 }),
    messages => {
      const pending = result(messages, "control_playback");
      assert.equal(pending.playbackOutcome, "pending");
      assert.equal(pending.handledBySystem, true);
      assert.equal(pending.retryable, false);
      store.change("s1", state => { state.command!.expiresAt = "2000-01-01T00:00:00.000Z"; });
      return call("control_playback", { action: "play", expectedPlaybackVersion: 1 }, "repeat-play");
    },
    messages => {
      assert.equal(result(messages, "control_playback").reused, true);
      assert.equal(result(messages, "control_playback").playbackOutcome, "pending");
      return new AIMessage("安排好了。");
    },
  ]);
  const { app, agent, store } = makeApp({ databasePath: ":memory:", music: fixtureMusic(), model,
    modelName: "test", ackTimeoutMs: 15 });
  try {
    store.create("s1");
    store.change("s1", state => { state.radio.current = tracks[1]; });
    agent.submit("s1", message());
    await agent.idle();
    const command = store.read("s1").command!;
    assert.equal(store.read("s1").commandProgress?.phase, "accepted");
    assert.equal(agent.radioState("s1").playback.status, "unknown");
    assert.equal(store.replay("s1", 0).filter(e => e.type === "playback.command").length, 1);
    const response = await post(app, "/api/lab/sessions/s1/playback/acks", {
      commandId: command.commandId, playbackVersion: command.playbackVersion,
      ackSequence: 1, trackId: tracks[1].id, status: "playing", positionMs: 120,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(store.read("s1").commandProgress?.phase, "succeeded");
    assert.equal(agent.radioState("s1").playback.status, "playing");
    const reused = await agent.control({ action: "play", expectedPlaybackVersion: 1 }, "s1", "manual-repeat") as any;
    assert.equal(reused.reused, true);
    assert.equal(reused.playbackOutcome, "playing");
    assert.equal(store.read("s1").radio.playbackVersion, 1);
    assert.equal(model.index, 3, "Late success must not trigger another model call");
  } finally { await app.close(); }
});

test("an explicit playback failure permits a fresh play command rather than an endless pending reuse", async () => {
  const { app, store, agent } = fixture(null);
  try {
    store.create("s1");
    store.change("s1", state => { state.radio.current = tracks[1]; });
    await agent.control({ action: "play", expectedPlaybackVersion: 0 }, "s1", "try-first");
    const first = store.read("s1").command!;
    await post(app, "/api/lab/sessions/s1/playback/acks", {
      commandId: first.commandId, playbackVersion: 1, trackId: tracks[1].id,
      ackSequence: 1, status: "failed", positionMs: 0,
    });
    assert.equal(store.read("s1").commandProgress?.phase, "failed");
    await agent.control({ action: "play", expectedPlaybackVersion: 1 }, "s1", "try-again");
    assert.notEqual(store.read("s1").command?.commandId, first.commandId);
    assert.equal(store.read("s1").radio.playbackVersion, 2);
    assert.equal(agent.radioState("s1").playback.status, "failed", "A new command does not fabricate a playing observation");
    assert.equal(agent.radioState("s1").command?.status, "accepted");
  } finally { await app.close(); }
});

test("command progress is independent of last observed playback and receipts never regress a result", async () => {
  const { app, agent, store } = fixture(null);
  try {
    store.create("s1");
    store.change("s1", state => { state.radio.current = tracks[1]; });
    await agent.control({ action: "play", expectedPlaybackVersion: 0 }, "s1", "first");
    const first = store.read("s1").command!;
    const receipt = { commandId: first.commandId, playbackVersion: 1 };
    assert.equal((await post(app, "/api/lab/sessions/s1/playback/receipts", { ...receipt, phase: "executing" })).statusCode, 200);
    await post(app, "/api/lab/sessions/s1/playback/receipts", { ...receipt, phase: "received" });
    assert.equal(agent.radioState("s1").command?.status, "executing");
    const ack = { ...receipt, trackId: tracks[1].id, positionMs: 42 };
    await post(app, "/api/lab/sessions/s1/playback/acks", { ...ack, ackSequence: 1, status: "loading" });
    assert.equal(agent.radioState("s1").playback.status, "loading");
    assert.equal(agent.radioState("s1").command?.status, "executing");
    const reused = await agent.control({ action: "play", expectedPlaybackVersion: 1 }, "s1", "buffer-repeat") as any;
    assert.equal(reused.reused, true);
    assert.equal(reused.playbackOutcome, "pending");
    assert.equal(store.read("s1").radio.playbackVersion, 1);
    await post(app, "/api/lab/sessions/s1/playback/acks", { ...ack, ackSequence: 2, status: "playing" });
    await post(app, "/api/lab/sessions/s1/playback/receipts", { ...receipt, phase: "executing" });
    assert.equal(agent.radioState("s1").command?.status, "succeeded");
    await agent.control({ action: "pause", expectedPlaybackVersion: 1 }, "s1", "pause");
    assert.equal(agent.radioState("s1").command?.status, "accepted");
    assert.equal(agent.radioState("s1").playback.status, "playing", "Sending a command is not a playback observation");
    assert.equal(agent.radioState("s1").playback.playingTrack?.id, tracks[1].id);
    assert.equal((await post(app, "/api/lab/sessions/s1/playback/receipts", { ...receipt, phase: "received" })).statusCode, 409);
    assert.equal((await post(app, "/api/lab/sessions/s1/playback/acks", { ...ack, ackSequence: 3, status: "failed" })).statusCode, 409);
    const pause = store.read("s1").command!;
    await post(app, "/api/lab/sessions/s1/playback/acks", {
      commandId: pause.commandId, playbackVersion: 2, trackId: tracks[1].id,
      ackSequence: 1, status: "paused", positionMs: 56,
    });
    assert.equal(agent.radioState("s1").playback.status, "paused");
    assert.equal(agent.radioState("s1").command?.status, "succeeded");
  } finally { await app.close(); }
});

for (const timing of ["now", "after_current"] as const) {
  test(`Queue tool ${timing}: separates commit from browser observation`, async () => {
    const model = new ScriptModel([
      () => call("update_music_queue", {
        candidateIds: ["candidate"], mode: "replace", timing, expectedQueueVersion: 0,
      }),
      (messages) => {
        const observed = result(messages, "update_music_queue");
        assert.equal(observed.queueCommitted, true);
        assert.equal(observed.playbackConfirmed, timing === "now");
        assert.equal(observed.playbackOutcome, timing === "now" ? "playing" : undefined);
        return new AIMessage("Queue processed.");
      },
    ]);
    const { app, store, agent } = makeApp({ model, modelName: "test-only", music: fixtureMusic(),
      databasePath: ":memory:", ackTimeoutMs: 100 });
    const pending: Promise<unknown>[] = [];
    try {
      store.create("s1");
      store.change("s1", (state) => {
        state.radio.current = tracks[1];
        state.candidates = [{ id: "candidate", requestId: "r1", track: tracks[2],
          resource: { availability: "full", reason: "test", expiresAt: Date.now() + 5000,
            url: "http://127.0.0.1/test.wav" } }];
      });
      const unsubscribe = store.subscribe("s1", (event) => {
        if (event.type === "playback.command") {
          pending.push(post(app, "/api/lab/sessions/s1/playback/acks", {
            commandId: event.payload.commandId, playbackVersion: event.payload.playbackVersion,
            ackSequence: 1, status: "playing", positionMs: 0, trackId: tracks[2].id,
          }));
        }
      });
      await post(app, "/api/lab/sessions/s1/messages", message());
      await agent.idle();
      await Promise.all(pending);
      unsubscribe();
      assert.equal(store.read("s1").runs[0].status, "completed");
      const events = store.replay("s1", 0);
      if (timing === "now") {
        assert.ok(events.findIndex((e) => e.type === "playback.observed") <
          events.findIndex((e) => e.type === "reply.final"));
      } else assert.equal(events.some((e) => e.type === "playback.command"), false);
    } finally { await app.close(); }
  });
}

test("createAgent with scripted test model: inspect, queue, ACK, HTTP dedup, durable restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claudio-agent-test-"));
  const database = join(directory, "agent.sqlite");
  const model = new ScriptModel([
    () => call("search_music", { query: "quiet", limit: 3 }),
    (messages) => call("inspect_music", {
      candidateIds: result(messages, "search_music").candidates.map((c: any) => c.candidateId),
    }),
    (messages) => {
      const inspected = result(messages, "inspect_music").results;
      assert.equal(inspected[0].playableCandidate, false);
      return call("update_music_queue", {
        candidateIds: inspected.filter((r: any) => r.playableCandidate).map((r: any) => r.candidateId),
        mode: "replace", timing: "now", expectedQueueVersion: 0,
      });
    },
    (messages) => {
      assert.equal(result(messages, "update_music_queue").playbackConfirmed, false);
      return new AIMessage("已安排，等待浏览器开始播放。");
    },
    (messages) => {
      const history = messages.find(message => message.text.startsWith("HISTORICAL_CONVERSATION_NOT_CURRENT_STATE\n"));
      assert.ok(history, "Earlier turns must be supplied as historical data");
      const turns = JSON.parse(history.text.split("\n").slice(1).join("\n"));
      assert.equal(turns.find((turn: { role: string }) => turn.role === "human")?.text, "工作时放点安静的音乐");
      return new AIMessage("在，慢慢来。");
    },
  ]);
  const first = fixture(model, database);
  try {
    await post(first.app, "/api/lab/sessions", { clientSessionId: "s1" });
    const ack = await post(first.app, "/api/lab/sessions/s1/messages", message());
    assert.equal(ack.statusCode, 200);
    assert.equal(ack.json().message.status, "saved");
    await first.agent.idle();
    let state = first.store.read("s1");
    assert.equal(state.radio.current?.id, "t_full");
    assert.equal(state.radio.queue[0]?.id, "t_other");
    assert.equal(state.playbackAck, null, "Queue acceptance cannot imply actual playback");
    assert.equal(state.messages.length, 2);
    assert.equal(state.runs[0].status, "completed");
    assert.ok(!JSON.stringify(state.messages).includes("INTERNAL_TEXT"));
    const events = first.store.replay("s1", 0);
    assert.deepEqual(events.map((e) => e.sequence), events.map((_, i) => i + 1));
    assert.equal(events.filter((e) => e.type === "playback.command").length, 1);
    assert.equal((await post(first.app, "/api/lab/sessions/s1/messages", message())).statusCode, 200);
    assert.equal(model.index, 4, "Duplicate submission must not call the model again");
    assert.equal((await post(first.app, "/api/lab/sessions/s1/messages",
      { ...message(), text: "changed text" })).statusCode, 409);
    const command = state.command!;
    const playbackAck = { commandId: command.commandId, playbackVersion: command.playbackVersion,
      status: "playing", positionMs: 0 };
    assert.equal((await post(first.app, "/api/lab/sessions/s1/playback/acks", playbackAck)).statusCode, 200);
    assert.equal(first.store.read("s1").playbackAck?.status, "playing");
    assert.equal((await post(first.app, "/api/lab/sessions/s1/playback/acks",
      { ...playbackAck, playbackVersion: 0 })).statusCode, 409);
    await post(first.app, "/api/lab/sessions/s1/messages", message("r2", "你还在吗"));
    await first.agent.idle();
    assert.equal(first.store.read("s1").messages.length, 4);
    await first.app.close();
    const second = fixture(null, database);
    try {
      state = second.store.read("s1");
      assert.equal(state.messages.length, 4);
      assert.equal(state.radio.current?.id, "t_full");
      assert.equal(state.playbackAck, null, "Restart cannot claim that browser audio is playing");
      assert.equal(state.command, null, "Restart cannot replay an old media command");
    } finally { await second.app.close(); }
  } finally {
    if (!first.store.db.open) rmSync(directory, { recursive: true, force: true });
    else { await first.app.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test("replace now / after_current; unavailable batch and stale versions preserve old queue", async () => {
  const fixtureApp = fixture(null);
  const { store, agent, app } = fixtureApp;
  try {
    store.create("s1");
    store.change("s1", (state) => {
      state.activeRequestId = "r1";
      state.radio.current = tracks[1];
      state.radio.queue = [tracks[2]];
      state.candidates = tracks.map((track) => ({
        id: track.id, requestId: "r1", track,
        resource: { availability: track.id === "t_preview" ? "preview_only" : "unknown",
          url: track.id === "t_preview" ? undefined : "http://127.0.0.1/a.wav",
          expiresAt: Date.now() + 20_000, reason: "test" },
      }));
    });
    const context = { sessionId: "s1", requestId: "r1" };
    assert.throws(() => agent.updateQueue({
      candidateIds: ["t_preview"], mode: "replace", timing: "now", expectedQueueVersion: 0,
    }, context, "op_failed"));
    assert.equal(store.read("s1").radio.current?.id, "t_full");
    assert.deepEqual(store.read("s1").radio.queue.map((t) => t.id), ["t_other"]);
    agent.updateQueue({ candidateIds: ["t_other"], mode: "replace", timing: "after_current", expectedQueueVersion: 0 },
      context, "op_after");
    assert.equal(store.read("s1").radio.current?.id, "t_full");
    assert.equal(store.read("s1").command, null);
    agent.updateQueue({ candidateIds: ["t_other"], mode: "replace", timing: "now", expectedQueueVersion: 1 },
      context, "op_now");
    assert.equal(store.read("s1").radio.current?.id, "t_other");
    const sequence = store.read("s1").lastSequence;
    agent.updateQueue({ candidateIds: ["t_other"], mode: "replace", timing: "now", expectedQueueVersion: 1 },
      context, "op_now");
    assert.equal(store.read("s1").lastSequence, sequence, "Operation replay must not reissue playback");
    assert.throws(() => agent.updateQueue({
      candidateIds: ["t_full"], mode: "replace", timing: "now", expectedQueueVersion: 0,
    }, context, "op_stale"));
    assert.throws(() => agent.updateQueue({
      candidateIds: ["t_full"], mode: "replace", timing: "now", expectedQueueVersion: 2,
    }, { ...context, requestId: "forged" }, "op_other_request"));
  } finally { await app.close(); }
});

test("cancel aborts in-flight music; next request cannot replay the interrupted graph", async () => {
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const model = new ScriptModel([
    () => call("search_music", { query: "quiet", limit: 3 }),
    (messages) => {
      assert.ok(!messages.some((m) => isToolMessage(m)), "Interrupted tool calls must not be replayed");
      return new AIMessage("好，这次先聊聊天。");
    },
  ]);
  const music: Music = {
    ...fixtureMusic(),
    async search(_, __, signal) {
      started();
      return new Promise((_, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  const { app, agent, store } = makeApp({ databasePath: ":memory:", model, modelName: "test-only", music });
  try {
    store.create("s1");
    await post(app, "/api/lab/sessions/s1/messages", message());
    await began;
    agent.cancel("s1", "r1");
    await agent.idle();
    assert.equal(store.read("s1").runs[0].status, "cancelled");
    assert.equal(store.read("s1").radio.current, null);
    await post(app, "/api/lab/sessions/s1/messages", message("r2", "不放歌了，先聊聊天"));
    await agent.idle();
    assert.equal(store.read("s1").runs[1].status, "completed");
    assert.equal(store.read("s1").radio.current, null);
  } finally { await app.close(); }
});

test("no configured model never produces fake replies; settings report unavailable capabilities", async () => {
  const { app, store } = fixture(null);
  try {
    store.create("s1");
    const response = await post(app, "/api/lab/sessions/s1/messages", message());
    assert.equal(response.statusCode, 503);
    assert.equal(store.read("s1").messages.length, 0);
    assert.equal((await app.inject({ method: "GET", url: "/api/lab/health" })).json().modelConfigured, false);
    const settings = await app.inject({
      method: "PATCH", url: "/api/lab/sessions/s1/settings",
      payload: { autoSpeech: true, proactive: true },
    });
    assert.equal(settings.statusCode, 409);
  } finally { await app.close(); }
});

test("provider adapter maps metadata, detects preview, and never invents membership cause", async () => {
  const originalFetch = globalThis.fetch;
  const responses: unknown[] = [
    { result: { songs: [{ id: 1, name: "Title", ar: [{ name: "Artist" }], dt: 180_000 }] } },
    { data: [{ id: 1, url: "http://127.0.0.1/short.wav", time: 30_000 }] },
    { data: [{ id: 1, url: null }] },
    { data: [{ id: 1, url: null }] },
  ];
  globalThis.fetch = (async () => new Response(JSON.stringify(responses.shift()))) as typeof fetch;
  try {
    const provider = new NeteaseMusic("http://127.0.0.1:3000");
    const found = await provider.search("quiet", 3, new AbortController().signal);
    assert.equal(found[0].artist, "Artist");
    const preview = await provider.inspect(found[0], new AbortController().signal);
    assert.equal(preview.availability, "preview_only");
    assert.equal(preview.url, "http://127.0.0.1/short.wav");
    assert.equal(preview.playableDurationMs, 30_000);
    const unknown = await provider.inspect(found[0], new AbortController().signal);
    assert.equal(unknown.availability, "unknown");
    assert.equal(unknown.url, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test("Netease transport uses POST body for credentials and reports upstream rejection", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
    assert.ok(!String(input).includes("cookie"));
    assert.equal(options?.method, "POST");
    const body = JSON.parse(String(options?.body));
    assert.equal(body.cookie, "TEST_COOKIE_NOT_REAL");
    assert.equal(body.crypto, "eapi");
    return new Response(JSON.stringify({ code: 301, message: "login required" }));
  }) as typeof fetch;
  try {
    await assert.rejects(
      new NeteaseMusic("http://127.0.0.1:3000", "TEST_COOKIE_NOT_REAL")
        .search("piano", 3, new AbortController().signal),
      /MUSIC_LOGIN_REQUIRED/,
    );
  } finally { globalThis.fetch = originalFetch; }
});
