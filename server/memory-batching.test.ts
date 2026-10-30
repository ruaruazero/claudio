import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { Knowledge, MEMORY_BATCH_POLICY as policy } from "./knowledge.js";
import { Store } from "./store.js";
import { makeApp } from "./http.js";
import { MockMusic } from "./mock-music.js";

class MemoryModel extends BaseChatModel {
  calls: BaseMessage[][] = [];
  constructor(private respond: (messages: BaseMessage[]) => string | Promise<string> = () => '{"items":[]}') { super({}); }
  _llmType() { return "TEST_MEMORY_BATCH"; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const message = new AIMessage({ content: await this.respond(messages),
      usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } });
    return { generations: [{ message, text: message.text }] };
  }
}
function add(knowledge: Knowledge, sessionId: string, count: number, at: number, prefix = "u") {
  for (let i = 0; i < count; i++) knowledge.archive(sessionId, {
    id: `${sessionId}-${prefix}${i}`, role: "user", text: `工作时喜欢钢琴 ${i}`,
    status: "saved", createdAt: new Date(at).toISOString(),
  });
  knowledge.schedule(sessionId);
}
function pending(store: Store, sessionId = "s1") {
  return (store.db.prepare("SELECT COUNT(*) AS count FROM lab_memory_queue WHERE session_id=? AND status='pending'")
    .get(sessionId) as { count: number }).count;
}
const input = (messages: BaseMessage[]) => JSON.parse(messages.at(-1)!.text) as {
  newSourceIds: string[]; evidence: { id: string }[];
};

test("five new messages wait until 30 seconds after the reply; empty output is processed once", async () => {
  const store = new Store(":memory:");
  const model = new MemoryModel();
  const knowledge = new Knowledge(store, model);
  const at = Date.now();
  try {
    store.create("s1");
    add(knowledge, "s1", 5, at);
    knowledge.archive("s1", { id: "reply", role: "assistant", source: "model",
      text: "收到。", status: "complete", createdAt: new Date(at + 10_000).toISOString() });
    knowledge.maintain(at + 39_999); await knowledge.idle();
    assert.equal(model.calls.length, 0);
    knowledge.maintain(at + 40_000); await knowledge.idle();
    assert.equal(model.calls.length, 1);
    assert.equal(pending(store), 0);
    knowledge.maintain(at + 600_000); await knowledge.idle();
    assert.equal(model.calls.length, 1);
    const work = JSON.parse((store.db.prepare("SELECT body FROM lab_ai_work").get() as { body: string }).body);
    assert.deepEqual({ count: work.evidenceCount, saved: work.savedCount, input: work.inputTokens,
      output: work.outputTokens, attempts: work.attempts, completed: work.completed },
    { count: 5, saved: 0, input: 100, output: 20, attempts: 1, completed: true });
  } finally { await knowledge.close(); store.db.close(); }
});

test("small batches wait five minutes and busy foreground/background work defers extraction", async () => {
  const store = new Store(":memory:");
  const model = new MemoryModel();
  const knowledge = new Knowledge(store, model);
  const at = Date.now();
  try {
    store.create("s1"); add(knowledge, "s1", 1, at);
    knowledge.maintain(at + policy.idleMs - 1); await knowledge.idle();
    assert.equal(model.calls.length, 0);
    knowledge.maintain(at + policy.idleMs, true); await knowledge.idle();
    assert.equal(model.calls.length, 0);
    store.change("s1", state => { state.activeRequestId = "busy"; });
    knowledge.maintain(at + policy.idleMs); await knowledge.idle();
    assert.equal(model.calls.length, 0);
    store.change("s1", state => { state.activeRequestId = null; state.backgroundRequestId = "refill"; });
    knowledge.maintain(at + policy.idleMs); await knowledge.idle();
    assert.equal(model.calls.length, 0);
    store.change("s1", state => { state.backgroundRequestId = null; });
    knowledge.maintain(at + policy.idleMs); await knowledge.idle();
    assert.equal(model.calls.length, 1);
  } finally { await knowledge.close(); store.db.close(); }
});

test("more than six messages are processed in bounded batches without losing same-timestamp evidence", async () => {
  const store = new Store(":memory:");
  const model = new MemoryModel();
  const knowledge = new Knowledge(store, model);
  const at = Date.now();
  try {
    store.create("s1"); add(knowledge, "s1", 13, at);
    knowledge.maintain(at + 30_000); await knowledge.idle();
    assert.equal(pending(store), 7);
    assert.equal(input(model.calls[0]).evidence.length, 6, "Unsubmitted pending messages must not leak into the batch");
    knowledge.maintain(at + 89_999); await knowledge.idle();
    assert.equal(model.calls.length, 1);
    knowledge.maintain(at + 90_000); await knowledge.idle();
    assert.equal(pending(store), 1);
    knowledge.maintain(at + 299_999); await knowledge.idle();
    assert.equal(model.calls.length, 2);
    knowledge.maintain(at + 300_000); await knowledge.idle();
    assert.equal(pending(store), 0);
    const ids = model.calls.flatMap(messages => input(messages).newSourceIds);
    assert.equal(ids.length, 13);
    assert.equal(new Set(ids).size, 13);
    assert.ok(model.calls.every(messages => input(messages).newSourceIds.length <= policy.batchSize));
  } finally { await knowledge.close(); store.db.close(); }
});

test("new messages during extraction stay pending and obey the next batch interval", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const model = new MemoryModel(async () => { await gate; return '{"items":[]}'; });
  const store = new Store(":memory:");
  const knowledge = new Knowledge(store, model);
  const at = Date.now();
  try {
    store.create("s1"); add(knowledge, "s1", 5, at);
    knowledge.maintain(at + 30_000);
    add(knowledge, "s1", 5, at + 35_000, "new");
    knowledge.maintain(at + 70_000);
    release(); await knowledge.idle();
    assert.equal(model.calls.length, 1);
    assert.equal(pending(store), 5);
    knowledge.maintain(at + 90_000); await knowledge.idle();
    assert.equal(model.calls.length, 2);
    assert.equal(pending(store), 0);
  } finally { release(); await knowledge.close(); store.db.close(); }
});

test("pending work and cooldown survive restart without requiring another user message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claudio-memory-batch-"));
  const filename = join(directory, "store.sqlite");
  let store = new Store(filename);
  const model = new MemoryModel();
  let knowledge = new Knowledge(store, model);
  const at = Date.now();
  try {
    store.create("s1"); add(knowledge, "s1", 12, at);
    knowledge.maintain(at + 30_000); await knowledge.idle();
    assert.equal(pending(store), 6);
    await knowledge.close(); store.db.close();
    store = new Store(filename);
    knowledge = new Knowledge(store, model);
    knowledge.maintain(at + 89_999); await knowledge.idle();
    assert.equal(model.calls.length, 1);
    knowledge.maintain(at + 90_000); await knowledge.idle();
    assert.equal(pending(store), 0);
    assert.equal(new Set(model.calls.flatMap(messages => input(messages).newSourceIds)).size, 12);
  } finally { await knowledge.close(); store.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("same-timestamp arrivals cannot displace in-flight evidence before its result is saved", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const model = new MemoryModel(async messages => {
    const ids = input(messages).newSourceIds;
    await gate;
    return JSON.stringify({ items: [{ text: "工作时喜欢钢琴", kind: "preference", scope: "work",
      certainty: "explicit", sourceIds: [ids.at(-1)] }] });
  });
  const store = new Store(":memory:");
  const knowledge = new Knowledge(store, model);
  const at = Date.now();
  try {
    store.create("s1"); add(knowledge, "s1", 6, at, "z");
    knowledge.maintain(at + 30_000);
    add(knowledge, "s1", 1, at, "a");
    release(); await knowledge.idle();
    assert.equal(knowledge.list().length, 1);
    assert.deepEqual(knowledge.list()[0].sourceIds, ["s1-z5"]);
    assert.equal(pending(store), 1);
  } finally { release(); await knowledge.close(); store.db.close(); }
});

test("legacy cursor and processed IDs are honored during queue migration", async () => {
  const store = new Store(":memory:");
  const first = new Knowledge(store, null);
  const at = Date.now();
  try {
    store.create("s1");
    first.archive("s1", { id: "old", role: "user", text: "old", status: "saved", createdAt: new Date(at - 1).toISOString() });
    first.archive("s1", { id: "handled", role: "user", text: "handled", status: "saved", createdAt: new Date(at).toISOString() });
    first.archive("s1", { id: "fresh", role: "user", text: "fresh", status: "saved", createdAt: new Date(at).toISOString() });
    first.setConfig("memoryCursor:s1", new Date(at).toISOString());
    first.setConfig("memoryProcessed:s1", ["handled"]);
    const model = new MemoryModel();
    const knowledge = new Knowledge(store, model);
    try {
      assert.equal(pending(store), 1);
      knowledge.maintain(at + policy.idleMs); await knowledge.idle();
      assert.deepEqual(input(model.calls[0]).newSourceIds, ["fresh"]);
    } finally { await knowledge.close(); }
  } finally { await first.close(); store.db.close(); }
});

test("failed extraction keeps evidence and backs off, including after repeated failures", async () => {
  const store = new Store(":memory:");
  let fail = true;
  const model = new MemoryModel(() => fail ? "invalid JSON" : '{"items":[]}');
  const knowledge = new Knowledge(store, model);
  const at = Date.now();
  try {
    store.create("s1"); add(knowledge, "s1", 5, at);
    knowledge.maintain(at + 30_000); await knowledge.idle();
    assert.equal(pending(store), 5);
    knowledge.maintain(at + 89_999); await knowledge.idle();
    assert.equal(model.calls.length, 1);
    knowledge.maintain(at + 90_000); await knowledge.idle();
    knowledge.maintain(at + 209_999); await knowledge.idle();
    assert.equal(model.calls.length, 2);
    fail = false;
    knowledge.maintain(at + 210_000); await knowledge.idle();
    assert.equal(model.calls.length, 3);
    assert.equal(pending(store), 0);
    assert.equal(knowledge.config("memoryFailures:s1", -1), 0);
  } finally { await knowledge.close(); store.db.close(); }
});

test("only one extraction runs globally and a second session respects global cooldown", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const model = new MemoryModel(async () => { await gate; return '{"items":[]}'; });
  const store = new Store(":memory:");
  const knowledge = new Knowledge(store, model);
  const at = Date.now();
  try {
    store.create("s1"); store.create("s2");
    add(knowledge, "s1", 5, at); add(knowledge, "s2", 5, at);
    knowledge.maintain(at + 30_000);
    knowledge.maintain(at + 90_000);
    release(); await knowledge.idle();
    assert.equal(model.calls.length, 1);
    knowledge.maintain(at + 89_999); await knowledge.idle();
    assert.equal(model.calls.length, 1);
    knowledge.maintain(at + 90_000); await knowledge.idle();
    assert.equal(model.calls.length, 2);
  } finally { release(); await knowledge.close(); store.db.close(); }
});

test("foreground-handled evidence and forgotten history do not produce background calls", async () => {
  const store = new Store(":memory:");
  const model = new MemoryModel();
  const knowledge = new Knowledge(store, model);
  const at = Date.now();
  try {
    store.create("s1"); add(knowledge, "s1", 1, at - 1000);
    knowledge.markHandled(["s1-u0"]);
    knowledge.maintain(at + policy.idleMs); await knowledge.idle();
    assert.equal(model.calls.length, 0);
    add(knowledge, "s1", 1, at - 500, "old");
    const memory = knowledge.save({ text: "钢琴", kind: "preference", scope: "work",
      certainty: "explicit", sourceIds: ["s1-old0"] });
    knowledge.forget(memory.id);
    knowledge.maintain(at + policy.idleMs); await knowledge.idle();
    assert.equal(model.calls.length, 0);
  } finally { await knowledge.close(); store.db.close(); }
});

test("ordinary agent replies enqueue evidence without an immediate extraction call", async () => {
  const model = new MemoryModel(() => "收到。");
  const { app, store, agent } = makeApp({ databasePath: ":memory:", model, modelName: "test",
    learning: true, musicProvider: "mock", music: new MockMusic("http://127.0.0.1:8082") });
  try {
    store.create("s1");
    agent.submit("s1", { requestId: "r1", clientMessageId: "m1", text: "工作时喜欢钢琴" });
    await agent.idle(); await agent.knowledge.idle();
    assert.equal(model.calls.length, 1, "Only the foreground reply used the model");
    assert.equal(pending(store), 1);
    agent.maintainMemory(); await agent.knowledge.idle();
    assert.equal(model.calls.length, 1);
  } finally { await app.close(); }
});
