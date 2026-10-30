import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { Store } from "./store.js";
import { Knowledge } from "./knowledge.js";
import { ContextManager, inputSize } from "./context.js";
import { EnvironmentService } from "./environment.js";
import { MusicAccount, MusicCredentials } from "./music-account.js";
import { NeteaseMusic } from "./music.js";
import { makeApp } from "./http.js";
import { MockMusic } from "./mock-music.js";

class Model extends BaseChatModel {
  calls: BaseMessage[][] = [];
  constructor(private respond: (messages: BaseMessage[]) => string | Promise<string>) { super({}); }
  _llmType() { return "TEST_PERSONALIZATION"; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const message = new AIMessage(await this.respond(messages));
    return { generations: [{ message, text: message.text }] };
  }
}
const summary = JSON.stringify({ intent: "安静工作", constraints: ["工作时不要人声"],
  facts: ["用户曾指定 Norah Jones"], unresolved: [] });
const user = (id: string, text = "工作时不要人声", at = new Date().toISOString()) => ({
  id, role: "user" as const, text, status: "saved" as const, createdAt: at,
});
test("context compacts automatically, persists coverage and preserves recent complete turns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claudio-context-"));
  const file = join(directory, "store.sqlite");
  let store = new Store(file);
  try {
    const model = new Model(() => summary);
    let knowledge = new Knowledge(store, model);
    const messages: BaseMessage[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push(new HumanMessage({ id: `u${i}`, content: i === 0 ? "工作时不要人声。" + "旧资料".repeat(300) : `turn ${i} ` + "conversation ".repeat(60) }));
      messages.push(new AIMessage({ id: `a${i}`, content: "answer ".repeat(70) }));
    }
    const manager = new ContextManager(knowledge, model, 8000, 2);
    const result = await manager.prepare("s1:0", messages, {}, new AbortController().signal);
    assert.ok(model.calls.length > 0);
    assert.ok(result[0].text.includes("工作时不要人声"));
    assert.deepEqual(result.slice(-4), messages.slice(-4));
    assert.ok(inputSize(result.map((message) => message.toDict())) + 2100 < 8000);
    const count = model.calls.length;
    await manager.prepare("s1:0", messages, {}, new AbortController().signal);
    assert.equal(model.calls.length, count, "A valid persisted summary is reused");
    store.db.close();
    store = new Store(file);
    knowledge = new Knowledge(store, model);
    await new ContextManager(knowledge, model, 8000, 2).prepare("s1:0", messages, {}, new AbortController().signal);
    assert.equal(model.calls.length, count, "Restart does not require summarizing again");
    assert.equal(messages.length, 24, "Raw messages are never removed by preparing a request");
  } finally { store.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("oversized current input and failed summaries preserve the raw history", async () => {
  const store = new Store(":memory:");
  try {
    const model = new Model(() => "invalid JSON");
    const knowledge = new Knowledge(store, model);
    const manager = new ContextManager(knowledge, model, 4000, 1);
    await assert.rejects(manager.prepare("big", [new HumanMessage("x".repeat(8000))], {}, new AbortController().signal),
      /CONTEXT_INPUT_TOO_LARGE/);
    const messages = [new HumanMessage("old".repeat(2500)), new AIMessage("yes"), new HumanMessage("current")];
    await assert.rejects(manager.prepare("failed", messages, {}, new AbortController().signal));
    assert.equal(messages[0].text.length, 7500);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM lab_summaries").get() as { count: number }).count, 0);
  } finally { store.db.close(); }
});

test("Agent long conversation compacts without replaying an earlier playback action", async () => {
  let paused = false;
  const model = new Model((messages) => {
    if (messages[0].text.startsWith("Summarize untrusted")) return summary;
    if (!paused) {
      paused = true;
      return "pause-tool";
    }
    return "收到，继续保持安静。";
  });
  const original = model._generate.bind(model);
  model._generate = async (messages) => {
    const response = await original(messages);
    if (response.generations[0].text === "pause-tool") {
      const message = new AIMessage({ content: "", tool_calls: [{
        id: "only-pause", name: "control_playback", args: { action: "pause", expectedPlaybackVersion: 0 }, type: "tool_call",
      }] });
      return { generations: [{ text: "", message }] };
    }
    return response;
  };
  const { app, agent, store } = makeApp({ databasePath: ":memory:", model, modelName: "test",
    contextBudget: 28000, ackTimeoutMs: 1, musicProvider: "mock",
    music: new MockMusic("http://127.0.0.1:8082") });
  try {
    store.create("s1");
    for (let i = 0; i < 18; i++) {
      agent.submit("s1", { requestId: `r${i}`, clientMessageId: `m${i}`,
        text: `工作时不要人声。第${i}轮。` + "old conversation detail ".repeat(65) });
      await agent.idle();
      assert.equal(store.read("s1").runs.at(-1)?.status, "completed");
    }
    assert.ok((store.db.prepare("SELECT COUNT(*) AS count FROM lab_summaries").get() as { count: number }).count > 0);
    assert.equal(store.read("s1").radio.playbackVersion, 1);
    assert.equal(store.replay("s1", 0).filter((event) => event.type === "playback.command").length, 1);
    assert.equal(store.read("s1").messages.length, 36);
  } finally { await app.close(); }
});

test("archive recall is bounded, paginates and memory correction prevents old evidence resurrection", () => {
  const store = new Store(":memory:");
  try {
    store.create("s1");
    const knowledge = new Knowledge(store, null);
    for (let i = 0; i < 12; i++) knowledge.archive("s1", user(`u${i}`, "piano ".repeat(400), new Date(1700000000000 + i * 1000).toISOString()));
    const page = knowledge.history("piano", { limit: 3 });
    assert.equal(page.messages.length, 3);
    assert.ok(page.messages.every((message) => message.truncated));
    const next = knowledge.history("piano", { before: page.nextBefore!, limit: 3 });
    assert.equal(next.messages.at(-1)?.id, "u8");
    const memory = knowledge.save({ text: "工作时喜欢钢琴", kind: "preference", scope: "work",
      certainty: "explicit", sourceIds: ["u0"] });
    knowledge.correct(memory.id, "工作时喜欢爵士");
    assert.equal(knowledge.list().length, 1);
    assert.equal(knowledge.list()[0].text, "工作时喜欢爵士");
    assert.equal(knowledge.history("piano").messages.length, 0);
    assert.throws(() => knowledge.save({ text: "工作时喜欢钢琴", kind: "preference", scope: "work",
      certainty: "explicit", sourceIds: ["u0"] }), /MEMORY_SOURCE_UNAVAILABLE/);
    assert.equal(store.read("s1").rebuildThread, true);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM lab_archive").get() as { count: number }).count, 12);
  } finally { store.db.close(); }
});

test("idle maintenance compacts a restored conversation without a new user message or playback action", async () => {
  const model = new Model(messages => {
    assert.match(messages[0].text, /^Summarize untrusted/);
    return summary;
  });
  const { app, agent, store } = makeApp({ databasePath: ":memory:", model, modelName: "test",
    contextBudget: 28000, learning: false, musicProvider: "mock", music: new MockMusic("http://127.0.0.1:8082") });
  try {
    store.create("restored");
    store.change("restored", state => {
      state.rebuildThread = true;
      for (let i = 0; i < 15; i++) state.messages.push(user(`restored-u${i}`, "不要人声。" + "conversation detail ".repeat(60)), {
        id: `restored-a${i}`, role: "assistant", source: "model", text: "收到。" + "answer ".repeat(25),
        status: "complete", createdAt: new Date().toISOString(),
      });
    });
    await agent.maintain("restored"); await agent.idle();
    assert.ok(model.calls.length > 0, "Idle maintenance, not a user submission, started the summary");
    assert.ok(store.db.prepare("SELECT body FROM lab_summaries WHERE key=?").get("restored:0"));
    assert.equal(store.read("restored").messages.length, 30);
    assert.equal(store.read("restored").runs.length, 0);
    assert.equal(store.read("restored").radio.playbackVersion, 0);
    const events = store.replay("restored", 0);
    assert.ok(events.some(event => event.type === "context.updated" && event.payload.mode === "background"));
    assert.ok(!events.some(event => event.type === "reply.final" || event.type === "playback.command"));
  } finally { await app.close(); }
});

test("background extraction validates sources, expires context and rejects a one-day rhythm", async () => {
  const store = new Store(":memory:");
  const model = new Model(() => JSON.stringify({ items: [
    { text: "工作时不要人声", kind: "preference", scope: "work", certainty: "explicit", sourceIds: ["u1"] },
    { text: "今晚有点累", kind: "context", scope: "tonight", certainty: "explicit", sourceIds: ["u1"] },
    { text: "每天下午工作", kind: "rhythm", scope: "afternoon", certainty: "inferred", sourceIds: ["u1"] },
    { text: "伪造的认识", kind: "preference", scope: "general", certainty: "explicit", sourceIds: ["missing"] },
  ] }));
  const knowledge = new Knowledge(store, model);
  try {
    store.create("s1"); knowledge.archive("s1", user("u1"));
    knowledge.extract("s1"); knowledge.extract("s1");
    await knowledge.idle();
    assert.equal(model.calls.length, 1);
    assert.equal(knowledge.list().length, 2);
    assert.ok(knowledge.list().find((item) => item.kind === "context")?.expiresAt);
    knowledge.extract("s1"); await knowledge.idle();
    assert.equal(model.calls.length, 1, "Already processed evidence does not cause a fresh model request");
  } finally { await knowledge.close(); store.db.close(); }
});

test("deleting a memory invalidates an in-flight extractor result", async () => {
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const model = new Model(async () => { started(); await gate; return JSON.stringify({ items: [
    { text: "喜欢钢琴", kind: "preference", scope: "general", certainty: "explicit", sourceIds: ["u1"] },
  ] }); });
  const store = new Store(":memory:");
  const knowledge = new Knowledge(store, model);
  try {
    store.create("s1"); knowledge.archive("s1", user("u1"));
    const memory = knowledge.save({ text: "喜欢钢琴", kind: "preference", scope: "general", certainty: "explicit", sourceIds: ["u1"] });
    knowledge.extract("s1"); await began; knowledge.forget(memory.id); release(); await knowledge.idle();
    assert.equal(knowledge.list().length, 0);
  } finally { release(); await knowledge.close(); store.db.close(); }
});

test("rhythm requires evidence from three local dates and stays a tentative expiring pattern", async () => {
  const store = new Store(":memory:");
  const model = new Model(() => JSON.stringify({ items: [{
    text: "近期下午多在专注工作", kind: "rhythm", scope: "afternoon", certainty: "inferred", sourceIds: ["day1", "day2", "day3"],
  }] }));
  const knowledge = new Knowledge(store, model);
  try {
    store.create("s1");
    for (let i = 1; i <= 3; i++) knowledge.archive("s1", user(`day${i}`, "下午继续专注写代码", `2026-10-2${i}T07:00:00.000Z`));
    knowledge.extract("s1"); await knowledge.idle();
    const pattern = knowledge.list()[0];
    assert.equal(pattern.kind, "rhythm");
    assert.equal(pattern.certainty, "inferred");
    assert.ok(pattern.expiresAt);
    assert.ok(model.calls[0].at(-1)?.text.includes("localTime"));
  } finally { await knowledge.close(); store.db.close(); }
});

test("new evidence arriving during extraction is drained even with the same timestamp", async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { started = resolve; });
  let count = 0;
  const model = new Model(async () => {
    if (++count === 1) { started(); await gate; }
    return '{"items":[]}';
  });
  const store = new Store(":memory:");
  const knowledge = new Knowledge(store, model);
  try {
    store.create("s1");
    const at = new Date().toISOString();
    knowledge.archive("s1", user("first", "第一句话", at));
    knowledge.extract("s1"); await began;
    knowledge.archive("s1", user("second", "第二句话", at));
    knowledge.extract("s1"); release(); await knowledge.idle();
    assert.equal(count, 2);
    knowledge.extract("s1"); await knowledge.idle();
    assert.equal(count, 2);
  } finally { release(); await knowledge.close(); store.db.close(); }
});

test("explicit conversation correction supersedes the referenced memory", async () => {
  const store = new Store(":memory:");
  let memoryId = "";
  const model = new Model(() => JSON.stringify({ items: [{
    text: "工作时现在喜欢爵士", kind: "preference", scope: "work", certainty: "explicit",
    sourceIds: ["new"], replaces: [memoryId],
  }] }));
  const knowledge = new Knowledge(store, model);
  try {
    store.create("s1");
    knowledge.archive("s1", user("old", "工作时喜欢钢琴", "2026-10-20T00:00:00.000Z"));
    memoryId = knowledge.save({ text: "工作时喜欢钢琴", kind: "preference", scope: "work",
      certainty: "explicit", sourceIds: ["old"] }).id;
    knowledge.archive("s1", user("new", "改一下，我工作时现在更喜欢爵士。"));
    knowledge.extract("s1"); await knowledge.idle();
    assert.equal(knowledge.list().length, 1);
    assert.ok(knowledge.list()[0].text.includes("爵士"));
    assert.equal(JSON.parse((store.db.prepare("SELECT body FROM lab_memory WHERE id=?").get(memoryId) as { body: string }).body).status, "superseded");
  } finally { await knowledge.close(); store.db.close(); }
});

test("weather uses manual coordinates, caches, and fails without blocking radio capability", async () => {
  const store = new Store(":memory:");
  try {
    const knowledge = new Knowledge(store, null);
    let calls = 0;
    const environment = new EnvironmentService(knowledge, (async () => {
      calls++; return Response.json({ current: { time: "2026-10-26T12:00", temperature_2m: 18, weather_code: 3 } });
    }) as typeof fetch);
    assert.equal((await environment.current()).weather, null);
    assert.equal(calls, 0);
    environment.setLocation({ name: "Shanghai", latitude: 31, longitude: 121, timezone: "Asia/Shanghai" });
    assert.equal((await environment.current()).weather?.temperature, 18);
    await environment.current();
    assert.equal(calls, 1);
    environment.setLocation({ name: "Beijing", latitude: 40, longitude: 116, timezone: "Asia/Shanghai" });
    const failed = new EnvironmentService(knowledge, (async () => { throw new Error("network"); }) as typeof fetch);
    assert.equal((await failed.current()).weather, null);
  } finally { store.db.close(); }
});

test("weather reference does not wait for the first network response", async () => {
  const store = new Store(":memory:");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const knowledge = new Knowledge(store, null);
  const environment = new EnvironmentService(knowledge, (async () => {
    await gate;
    return Response.json({ current: { time: "2026-10-26T12:00", temperature_2m: 18, weather_code: 0 } });
  }) as typeof fetch);
  try {
    environment.setLocation({ name: "Shanghai", latitude: 31, longitude: 121, timezone: "Asia/Shanghai" });
    const first = await environment.current(undefined, false);
    assert.equal(first.weather, null);
    release();
    assert.equal((await environment.current()).weather?.description, "晴");
  } finally { release(); await environment.close(); store.db.close(); }
});

test("music credentials are private and encrypted; login never returns cookies; playlist seeds are weak and deduplicated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claudio-credentials-"));
  const store = new Store(":memory:");
  try {
    const knowledge = new Knowledge(store, null);
    const credentials = new MusicCredentials(directory);
    credentials.save("test-secret-cookie");
    assert.equal(credentials.read(), "test-secret-cookie");
    assert.ok(!readFileSync(join(directory, "netease-credential.enc")).includes("test-secret-cookie"));
    assert.equal(statSync(join(directory, "netease-credential.key")).mode & 0o777, 0o600);
    const music = new NeteaseMusic("http://127.0.0.1:3000");
    const account = new MusicAccount(knowledge, music, credentials, {
      async login_status() { return { body: { data: { profile: { userId: 1, nickname: "Test" } } } }; },
      async login_qr_key() { return { body: { data: { unikey: "key" } } }; },
      async login_qr_create() { return { body: { data: { qrimg: "data:image/png;base64,YQ==" } } }; },
      async login_qr_check() { return { body: { code: 803, cookie: "new-secret-cookie" } }; },
      async playlist_detail() { return { body: { playlist: { id: 123, name: "Test Playlist",
        trackIds: [{ id: 1 }, { id: 2 }, { id: 3 }], tracks: [
          { id: 1, name: "one", ar: [{ name: "Norah Jones" }] },
          { id: 1, name: "one", ar: [{ name: "Norah Jones" }] },
          { id: 2, name: "two", ar: [{ name: "Norah Jones" }] },
        ] } } }; },
    });
    assert.equal((await account.status()).connected, true);
    const qr = await account.qr();
    const result = await account.check(qr.key);
    assert.equal(result.status, "connected");
    assert.ok(!JSON.stringify(result).includes("cookie"));
    assert.equal(credentials.read(), "new-secret-cookie");
    const imported = await account.importPlaylist("https://music.163.com/#/playlist?id=123");
    assert.equal(imported.imported, 2);
    assert.equal(imported.partial, true);
    assert.equal(imported.memory.certainty, "inferred");
    await account.importPlaylist("123");
    assert.equal(knowledge.list().length, 2, "Legacy import summary and structured artist preference coexist");
    assert.equal(knowledge.profile().length, 1);
    assert.equal(knowledge.profile()[0].evidenceCount, 1, "Re-importing does not inflate evidence");
    account.logout();
    assert.equal(credentials.read(), undefined);
    assert.equal((await account.status()).connected, false);
  } finally { store.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("opening is idempotent and feedback binds to the current track", async () => {
  const model = new Model(() => "我在，今天也慢慢来。");
  const { app, agent, store } = makeApp({ databasePath: ":memory:", model, modelName: "test",
    musicProvider: "mock", music: new MockMusic("http://127.0.0.1:8082") });
  try {
    store.create("s1");
    const first = agent.opening("s1", "opening-1");
    assert.equal(first.duplicate, false);
    assert.equal(agent.opening("s1", "opening-2").duplicate, true);
    await agent.idle();
    assert.equal(store.read("s1").messages.length, 1);
    assert.equal(store.read("s1").messages[0].role, "assistant");
    assert.equal(agent.opening("s1", "opening-3").duplicate, true);
    assert.equal(model.calls.length, 1);
    assert.equal(agent.opening("s1", "startup-1", true).duplicate, false,
      "A new launch with an empty queue can select music again on the same day");
    assert.equal(agent.opening("s1", "startup-1", true).duplicate, true);
    await agent.idle();
    assert.equal(model.calls.length, 2);
    assert.equal(agent.opening("s1", "startup-1", true).duplicate, true);
    store.change("s1", (state) => { state.radio.current = { id: "track", title: "one", artist: "Test" }; });
    const stale = await app.inject({ method: "POST", url: "/api/lab/sessions/s1/feedback",
      payload: { trackId: "old-track", choice: "dislike" } });
    assert.equal(stale.statusCode, 409);
    const good = await app.inject({ method: "POST", url: "/api/lab/sessions/s1/feedback",
      payload: { trackId: "track", choice: "like" } });
    assert.equal(good.statusCode, 200);
    assert.equal(agent.knowledge.config<Record<string, string>>("trackFeedback", {}).track, "like");
  } finally { await app.close(); }
});

test("automatic selection cannot queue an explicitly disliked track", async () => {
  const { app, agent, store } = makeApp({ databasePath: ":memory:", model: null, modelName: null,
    musicProvider: "mock", music: new MockMusic("http://127.0.0.1:8082") });
  try {
    store.create("s1");
    const track = { id: "disliked", title: "one", artist: "Test" };
    agent.knowledge.setConfig("trackFeedback", { disliked: "dislike" });
    store.change("s1", (state) => {
      state.activeRequestId = "r1";
      state.radio.current = { id: "current", title: "current", artist: "Test" };
      state.candidates = [{ id: "candidate", requestId: "r1", track, resource: {
        availability: "full", url: "http://localhost/one.wav", reason: "test", expiresAt: Date.now() + 60000,
      } }];
    });
    const input = { candidateIds: ["candidate"], mode: "append" as const, timing: "after_current" as const,
      intent: "implicit_adaptation" as const, expectedQueueVersion: 0 };
    const context = { sessionId: "s1", requestId: "r1", controlEpoch: 0 };
    assert.throws(() => agent.updateQueue(input, context, "implicit"), /EXPLICIT_DISLIKE/);
    assert.equal(store.read("s1").radio.queue.length, 0);
    agent.updateQueue({ ...input, intent: "explicit_queue" }, context, "explicit");
    assert.equal(store.read("s1").radio.queue.length, 1, "A fresh explicit request can override old weak context");
  } finally { await app.close(); }
});
