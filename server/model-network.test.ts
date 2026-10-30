import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { ChatDeepSeek } from "@langchain/deepseek";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { callModelWithRecovery, createModelFetch, modelFailure } from "./model-network.js";
import { makeApp } from "./http.js";
import type { ModelAttempt } from "../src/protocol.js";

const completion = () => new Response(JSON.stringify({
  id: "test-response", object: "chat.completion", created: 1, model: "test",
  choices: [{ index: 0, message: { role: "assistant", content: "我在，慢慢来。" }, finish_reason: "stop" }],
}), { headers: { "Content-Type": "application/json" } });
function modelWithFetch(fetcher: typeof fetch) {
  return new ChatDeepSeek({ apiKey: "TEST_SECRET", model: "test", maxRetries: 0,
    timeout: 1000, configuration: { baseURL: "http://127.0.0.1:9", fetch: createModelFetch(fetcher) } });
}
const networkError = (code = "UND_ERR_CONNECT_TIMEOUT") =>
  new TypeError("PRIVATE_URL_AND_CREDENTIALS", { cause: Object.assign(new Error("PRIVATE_DETAIL"), { code }) });

test("real SDK recovers a connect timeout once and retains sanitized cause before LangChain drops it", async () => {
  let calls = 0;
  const events: ModelAttempt[] = [];
  const model = modelWithFetch(async () => { if (++calls === 1) throw networkError(); return completion(); });
  const response = await callModelWithRecovery((signal) => model.invoke("hello", { signal }), {
    retryDelayMs: 0, onAttempt: (e) => events.push(e),
  });
  assert.equal(response.text, "我在，慢慢来。");
  assert.equal(calls, 2);
  assert.deepEqual(events.map((e) => e.phase), ["started", "retrying", "started", "completed"]);
  assert.equal(events[1].networkCode, "UND_ERR_CONNECT_TIMEOUT");
  assert.equal(events[1].code, "MODEL_CONNECT_TIMEOUT");
  assert.equal(new Set(events.map((e) => e.callId)).size, 1);
  assert.ok(!JSON.stringify(events).includes("PRIVATE"));
  assert.ok(!JSON.stringify(events).includes("TEST_SECRET"));
});

test("repeated connection reset stops after two requests with a model-specific failure", async () => {
  let calls = 0;
  const model = modelWithFetch(async () => { calls++; throw networkError("ECONNRESET"); });
  const events: ModelAttempt[] = [];
  await assert.rejects(callModelWithRecovery((signal) => model.invoke("hello", { signal }), {
    retryDelayMs: 0, onAttempt: (e) => events.push(e),
  }), /MODEL_CONNECTION_RESET/);
  assert.equal(calls, 2);
  assert.equal(events.at(-1)?.phase, "failed");
});

for (const status of [401, 402, 403, 400, 422]) {
  test(`HTTP ${status} is not retried`, async () => {
    let calls = 0;
    const model = modelWithFetch(async () => {
      calls++; return new Response(JSON.stringify({ error: { message: "SECRET" } }), { status });
    });
    await assert.rejects(callModelWithRecovery((signal) => model.invoke("hello", { signal }), {
      retryDelayMs: 0, onAttempt() {},
    }));
    assert.equal(calls, 1);
  });
}

test("HTTP 503 recovers, but a long Retry-After is respected without an early retry", async () => {
  for (const longWait of [false, true]) {
    let calls = 0;
    const events: ModelAttempt[] = [];
    const model = modelWithFetch(async () => {
      if (++calls > 1) return completion();
      return new Response("{}", { status: 503, headers: { "retry-after": longWait ? "60" : "0" } });
    });
    const request = callModelWithRecovery((signal) => model.invoke("hello", { signal }), {
      retryDelayMs: 0, onAttempt: (e) => events.push(e),
    });
    if (longWait) await assert.rejects(request, /MODEL_UNAVAILABLE/); else await request;
    assert.equal(calls, longWait ? 1 : 2);
    assert.equal(events[1].status, 503);
  }
});

test("HTTP 429 honors Retry-After and cancellation interrupts that wait", async () => {
  const controller = new AbortController();
  let calls = 0;
  const model = modelWithFetch(async () => {
    calls++; return new Response("{}", { status: 429, headers: { "retry-after": "2" } });
  });
  await assert.rejects(callModelWithRecovery((signal) => model.invoke("hello", { signal }), {
    signal: controller.signal, retryDelayMs: 0, onAttempt(e) {
      if (e.phase === "retrying") {
        assert.equal(e.code, "MODEL_RATE_LIMITED");
        assert.ok(e.retryInMs! >= 2000);
        controller.abort();
      }
    },
  }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("SDK retries a response interrupted in its body before exposing partial text", async () => {
  let calls = 0;
  const events: ModelAttempt[] = [];
  const model = modelWithFetch(async () => {
    if (++calls > 1) return completion();
    let first = true;
    return new Response(new ReadableStream({
      pull(controller) {
        if (first) { first = false; controller.enqueue(new TextEncoder().encode('{"id":"partial"')); }
        else controller.error(networkError("ECONNRESET"));
      },
    }), { headers: { "Content-Type": "application/json" } });
  });
  const reply = await callModelWithRecovery((signal) => model.invoke("hello", { signal }), {
    retryDelayMs: 0, onAttempt: (e) => events.push(e),
  });
  assert.equal(calls, 2);
  assert.equal(reply.text, "我在，慢慢来。");
  assert.equal(events[1].networkCode, "ECONNRESET");
});

test("cancel during backoff sends no second request", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(callModelWithRecovery(async () => {
    calls++; throw Object.assign(new Error("PRIVATE"), { name: "TimeoutError" });
  }, { signal: controller.signal, retryDelayMs: 5000, onAttempt(e) {
    if (e.phase === "retrying") controller.abort();
  } }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("per-attempt deadline aborts a stalled response body instead of waiting for the whole run", async () => {
  const server = createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"id":"unfinished"');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const model = new ChatDeepSeek({ apiKey: "test", model: "test", maxRetries: 0,
      configuration: { baseURL: `http://127.0.0.1:${(server.address() as any).port}`, fetch: createModelFetch() } });
    const events: ModelAttempt[] = [];
    await assert.rejects(callModelWithRecovery((signal) => model.invoke("hello", { signal }), {
      timeoutMs: 80, retryDelayMs: 0, onAttempt: (e) => events.push(e),
    }), /MODEL_REQUEST_TIMEOUT/);
    assert.equal(events.filter((e) => e.phase === "started").length, 2);
    assert.equal(events.at(-1)?.code, "MODEL_REQUEST_TIMEOUT");
  } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});

test("DNS, TLS and unknown failures retain honest distinct classifications", () => {
  assert.equal(modelFailure(networkError("EAI_AGAIN")).retryable, true);
  assert.equal(modelFailure(networkError("ENOTFOUND")).retryable, false);
  assert.equal(modelFailure(networkError("CERT_HAS_EXPIRED")).code, "MODEL_TLS_FAILED");
  assert.equal(modelFailure(networkError("CERT_HAS_EXPIRED")).retryable, false);
  assert.equal(modelFailure(new Error("unknown")).retryable, false);
});

test("concurrent requests keep their network diagnostics separate", async () => {
  const histories = [[], []] as ModelAttempt[][];
  const results = await Promise.all([0, 1].map(async (index) => {
    const model = modelWithFetch(async () => {
      if (index === 0) { await new Promise((r) => setTimeout(r, 10)); throw networkError("ENOTFOUND"); }
      return completion();
    });
    try {
      await callModelWithRecovery((signal) => model.invoke("hello", { signal }), {
        retryDelayMs: 0, onAttempt: (e) => histories[index].push(e),
      });
      return "ok";
    } catch { return "failed"; }
  }));
  assert.deepEqual(results, ["failed", "ok"]);
  assert.equal(histories[0].at(-1)?.networkCode, "ENOTFOUND");
  assert.equal(histories[1].at(-1)?.phase, "completed");
  assert.ok(histories[1].every((e) => !e.networkCode));
});

test("real Agent and SDK preserve transport cause and disable tools on recovery after a committed action", async () => {
  let calls = 0;
  const model = modelWithFetch(async (_, init) => {
    const body = JSON.parse(String(init?.body));
    if (++calls === 1) return new Response(JSON.stringify({
      id: "first", object: "chat.completion", created: 1, model: "test",
      choices: [{ index: 0, finish_reason: "tool_calls", message: {
        role: "assistant", content: "", tool_calls: [{
          id: "pause", type: "function", function: { name: "control_playback",
            arguments: JSON.stringify({ action: "pause", expectedPlaybackVersion: 0 }) },
        }],
      } }],
    }), { headers: { "Content-Type": "application/json" } });
    if (calls === 2) throw networkError("ECONNRESET");
    assert.equal(body.tool_choice, "none");
    assert.ok(!body.tools?.length);
    return completion();
  });
  const { app, store, agent } = makeApp({ databasePath: ":memory:", model, modelName: "test",
    ackTimeoutMs: 1, music: { async search() { return []; }, async inspect() { throw new Error("unused"); } } });
  try {
    store.create("s1");
    agent.submit("s1", { requestId: "r1", clientMessageId: "m1", text: "暂停" });
    await agent.idle();
    assert.equal(calls, 3);
    const events = store.replay("s1", 0);
    const retry = events.find((e) => e.type === "model.attempt" && e.payload.phase === "retrying");
    assert.ok(retry?.type === "model.attempt");
    assert.equal(retry.payload.networkCode, "ECONNRESET");
    assert.equal(events.filter((e) => e.type === "playback.command").length, 1);
    assert.equal(store.read("s1").runs[0].status, "completed");
    assert.equal(store.read("s1").messages.at(-1)?.source, "model");
    const terminal = events.find((e) => e.type === "run.completed");
    assert.ok(terminal?.type === "run.completed");
    assert.equal(terminal.payload.inputTokens, undefined, "Missing SDK usage must not break result persistence");
  } finally { await app.close(); }
});

class RecoveryModel extends BaseChatModel {
  index = 0;
  constructor(private steps: ((messages: BaseMessage[]) => AIMessage)[]) { super({}); }
  _llmType() { return "TEST_RECOVERY"; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const step = this.steps[this.index++];
    assert.ok(step, "Unexpected extra model request");
    const message = step(messages);
    return { generations: [{ text: message.text, message }] };
  }
}
for (const outcome of ["recover", "fail", "illegal-tool", "cancel"] as const) {
  test(`Agent recovery after playback commit never repeats the action: ${outcome}`, async () => {
    const model = new RecoveryModel([
      () => new AIMessage({ content: "", tool_calls: [{
        id: "pause", name: "control_playback", args: { action: "pause", expectedPlaybackVersion: 0 },
      }] }),
      () => { throw Object.assign(new Error("PRIVATE"), { name: "TimeoutError" }); },
      (messages) => {
        assert.ok(messages.some((m) => m.text.includes("现在只生成最终回复")));
        if (outcome === "fail") throw Object.assign(new Error("PRIVATE"), { name: "TimeoutError" });
        if (outcome === "illegal-tool") return new AIMessage({ content: "", tool_calls: [{
          id: "repeat", name: "control_playback", args: { action: "pause", expectedPlaybackVersion: 1 },
        }] });
        return new AIMessage("先歇一会儿，我在。");
      },
    ]);
    const { app, store, agent } = makeApp({ databasePath: ":memory:", model, modelName: "test",
      ackTimeoutMs: 1, music: { async search() { return []; }, async inspect() { throw new Error("unused"); } } });
    try {
      store.create("s1");
      store.subscribe("s1", (e) => {
        if (outcome === "cancel" && e.type === "model.attempt" && e.payload.phase === "retrying") agent.cancel("s1", "r1");
      });
      agent.submit("s1", { requestId: "r1", clientMessageId: "m1", text: "暂停一下" });
      await agent.idle();
      const events = store.replay("s1", 0);
      assert.equal(events.filter((e) => e.type === "playback.command").length, 1);
      assert.equal(store.read("s1").runs[0].actions?.length, 1);
      assert.equal(model.index, outcome === "cancel" ? 2 : 3);
      assert.equal(store.read("s1").runs[0].status,
        outcome === "cancel" ? "cancelled" : outcome === "recover" ? "completed" : "partial");
      assert.equal(events.filter((e) => e.type === "reply.final").length, outcome === "cancel" ? 0 : 1);
      if (outcome === "fail") assert.equal(store.read("s1").runs[0].failureCode, "MODEL_REQUEST_TIMEOUT");
      if (outcome === "illegal-tool") assert.equal(store.read("s1").runs[0].failureCode, "FINAL_REPLY_REQUIRED");
      assert.ok(!JSON.stringify(events).includes("PRIVATE"));
    } finally { await app.close(); }
  });
}
