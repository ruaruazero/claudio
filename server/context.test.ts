import assert from "node:assert/strict";
import { test } from "node:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { ContextManager, inputSize, type ContextProgress } from "./context.js";
import { Knowledge } from "./knowledge.js";
import { Store } from "./store.js";

const valid = JSON.stringify({ intent: "推荐工作音乐", constraints: ["不要人声"], facts: ["用户在做重复工作"], unresolved: ["待推荐歌曲"] });
class SummaryModel extends BaseChatModel {
  calls: BaseMessage[][] = [];
  constructor(private respond: (messages: BaseMessage[], count: number) => string | Promise<string>) { super({}); }
  _llmType() { return "CONTEXT_TEST"; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const message = new AIMessage(await this.respond(messages, this.calls.length));
    return { generations: [{ message, text: message.text }] };
  }
}
const history = (turns = 12) => Array.from({ length: turns }, (_, i) => [
  new HumanMessage({ id: `u${i}`, content: `turn ${i} 不要人声。` + "conversation ".repeat(35) }),
  new AIMessage({ id: `a${i}`, content: "answer ".repeat(30) }),
]).flat();
const size = (messages: BaseMessage[]) => 2000 + inputSize({}) + inputSize(messages.map(m => m.toDict()));
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

test("background compaction is single-flight, does not delay new messages and keeps the appended tail", async () => {
  const store = new Store(":memory:");
  const began = gate(); const release = gate();
  const model = new SummaryModel(async () => { began.resolve(); await release.promise; return valid; });
  const knowledge = new Knowledge(store, model);
  const messages = history();
  const events: ContextProgress[] = [];
  const manager = new ContextManager(knowledge, model, Math.ceil(size(messages) / 0.8), 2,
    { onProgress: (_, progress) => events.push(progress) });
  try {
    const signal = new AbortController().signal;
    await manager.prepare("s:0", messages, {}, signal);
    assert.equal(model.calls.length, 0, "A fitting request never waits for optional compaction");
    manager.schedule("s:0", messages); manager.schedule("s:0", messages);
    await began.promise;
    assert.equal(model.calls.length, 1);
    const next = [...messages, new HumanMessage("新消息：这首是谁唱的？")];
    const progress: ContextProgress[] = [];
    const prepared = await manager.prepare("s:0", next, {}, signal, item => progress.push(item));
    assert.equal(prepared.at(-1), next.at(-1));
    assert.equal(progress.length, 0, "Background work is invisible when the request fits");
    release.resolve(); await manager.idle();
    const compacted = await manager.prepare("s:0", next, {}, signal);
    assert.match(compacted[0].text, /不要人声/);
    assert.equal(compacted.at(-1), next.at(-1));
    assert.equal(next.length, messages.length + 1);
    assert.ok(events.some(event => event.mode === "background" && event.phase === "completed"));
  } finally { release.resolve(); await manager.close(); store.db.close(); }
});

test("summary facts overflow is repaired once with explicit schema limits instead of aborting the request", async () => {
  const store = new Store(":memory:");
  const model = new SummaryModel((_, count) => count === 1 ? JSON.stringify({ intent: "work", constraints: ["不要人声"],
    facts: Array.from({ length: 17 }, (_, i) => `fact ${i}`), unresolved: [] }) : valid);
  const messages = history(8);
  const manager = new ContextManager(new Knowledge(store, model), model, 8500, 1);
  const progress: ContextProgress[] = [];
  try {
    const result = await manager.prepare("repair:0", messages, {}, new AbortController().signal, event => progress.push(event));
    assert.ok(model.calls.length >= 2);
    assert.match(model.calls[0][0].text, /facts <= 16 items/);
    assert.match(model.calls[1][0].text, /previous attempt failed local validation: facts/);
    assert.match(result[0].text, /不要人声/);
    assert.deepEqual(progress.map(event => event.phase), ["waiting", "completed"]);
    assert.ok(size(result) <= 8500);
  } finally { await manager.close(); store.db.close(); }
});

test("failed background compaction preserves the last valid summary and applies a retry cooldown", async () => {
  const store = new Store(":memory:");
  let broken = false;
  const model = new SummaryModel(() => broken ? "not JSON" : valid);
  const manager = new ContextManager(new Knowledge(store, model), model, 8500, 1);
  const events: ContextProgress[] = [];
  const knowledge = new Knowledge(store, model);
  const background = new ContextManager(knowledge, model, 18000, 1, { onProgress: (_, event) => events.push(event) });
  try {
    await manager.prepare("saved:0", history(8), {}, new AbortController().signal);
    const saved = (store.db.prepare("SELECT body FROM lab_summaries WHERE key=?").get("saved:0") as { body: string }).body;
    broken = true;
    const messages = history(20);
    background.schedule("saved:0", messages, {});
    await background.idle();
    assert.equal((store.db.prepare("SELECT body FROM lab_summaries WHERE key=?").get("saved:0") as { body: string }).body, saved);
    const count = model.calls.length;
    background.schedule("saved:0", messages, {}); await background.idle();
    assert.equal(model.calls.length, count);
    assert.equal(events.at(-1)?.code, "CONTEXT_SUMMARY_INVALID");
    assert.equal(events.at(-1)?.phase, "deferred");
    assert.equal(messages.length, 40);
  } finally { await manager.close(); await background.close(); store.db.close(); }
});

test("an oversized request reports a context-specific failure after bounded repair, not a model failure", async () => {
  const store = new Store(":memory:");
  const model = new SummaryModel(() => "invalid");
  const manager = new ContextManager(new Knowledge(store, model), model, 8500, 1);
  const progress: ContextProgress[] = [];
  try {
    await assert.rejects(manager.prepare("failed:0", history(8), {}, new AbortController().signal,
      event => progress.push(event)), /CONTEXT_SUMMARY_INVALID/);
    assert.equal(model.calls.length, 2);
    assert.deepEqual(progress.map(event => event.phase), ["waiting", "failed"]);
    assert.equal(progress.at(-1)?.code, "CONTEXT_SUMMARY_INVALID");
  } finally { await manager.close(); store.db.close(); }
});

test("a memory revision change discards a background result instead of resurrecting forgotten context", async () => {
  const store = new Store(":memory:");
  const began = gate(); const release = gate();
  const model = new SummaryModel(async () => { began.resolve(); await release.promise; return valid; });
  const knowledge = new Knowledge(store, model);
  const manager = new ContextManager(knowledge, model, 18000, 2);
  try {
    manager.schedule("forget:0", history(12), {}); await began.promise;
    knowledge.setConfig("memoryRevision", knowledge.revision + 1);
    release.resolve(); await manager.idle();
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM lab_summaries").get() as { n: number }).n, 0);
  } finally { release.resolve(); await manager.close(); store.db.close(); }
});

test("cancelling a foreground waiter does not cancel the shared background compaction", async () => {
  const store = new Store(":memory:");
  const began = gate(); const release = gate();
  const model = new SummaryModel(async () => { began.resolve(); await release.promise; return valid; });
  const manager = new ContextManager(new Knowledge(store, model), model, 12000, 1);
  try {
    manager.schedule("cancel:0", history(12), {}); await began.promise;
    const controller = new AbortController();
    const waiting = manager.prepare("cancel:0", history(14), {}, controller.signal);
    controller.abort();
    await assert.rejects(waiting, error => error instanceof DOMException && error.name === "AbortError");
    release.resolve(); await manager.idle();
    assert.ok(store.db.prepare("SELECT body FROM lab_summaries WHERE key=?").get("cancel:0"));
  } finally { release.resolve(); await manager.close(); store.db.close(); }
});

test("compaction chunks preserve complete AI tool call and result groups", async () => {
  const store = new Store(":memory:");
  const messages: BaseMessage[] = [];
  for (let i = 0; i < 8; i++) messages.push(new HumanMessage(`user ${i} ` + "detail ".repeat(70)),
    new AIMessage({ content: "", tool_calls: [{ id: `call${i}`, name: "search_music", args: { query: "piano" }, type: "tool_call" }] }),
    new ToolMessage({ tool_call_id: `call${i}`, content: "song ".repeat(120) }), new AIMessage("推荐给你。"));
  const model = new SummaryModel(input => {
    const source = JSON.parse(input.at(-1)!.text).messages;
    assert.equal(source[0].type, "human");
    assert.notEqual(source.at(-1).type, "tool", "Complete user turns end with the assistant reply");
    for (const message of source) if (message.type === "ai" && message.data.tool_calls?.length) {
      for (const call of message.data.tool_calls) assert.ok(source.some((item: any) => item.type === "tool" && item.data.tool_call_id === call.id));
    }
    return valid;
  });
  const manager = new ContextManager(new Knowledge(store, model), model, 10000, 1);
  try {
    const result = await manager.prepare("tools:0", messages, {}, new AbortController().signal);
    assert.equal(result.at(-1), messages.at(-1));
    assert.ok(model.calls.length > 1);
  } finally { await manager.close(); store.db.close(); }
});
