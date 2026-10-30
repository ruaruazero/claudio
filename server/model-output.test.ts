import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { ChatDeepSeek } from "@langchain/deepseek";
import { AIMessage } from "@langchain/core/messages";
import { makeApp } from "./http.js";
import { createModelFetch } from "./model-network.js";
import { ConversationService } from "./conversation-service.js";
import { hasToolProtocolText, hiddenReplyText } from "../src/model-output.js";
import { spokenText } from "./speech.js";

const dsml = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="send_message">' +
  '<｜｜DSML｜｜ parameter name="text" string="true">换好了。</｜｜DSML｜｜ parameter>' +
  '</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
function response(content: string, name?: string, args?: object | string) {
  return Response.json({ id: `fixture-${randomUUID()}`, object: "chat.completion", created: 1, model: "test",
    choices: [{ index: 0, finish_reason: name ? "tool_calls" : "stop", message: {
      role: "assistant", content,
      ...(name ? { tool_calls: [{ id: `call-${name}`, type: "function", function: {
        name, arguments: typeof args === "string" ? args : JSON.stringify(args),
      } }] } : {}),
    } }],
  });
}
function sdk(fetcher: typeof fetch) {
  return new ChatDeepSeek({ apiKey: "offline-fixture", model: "test", maxRetries: 0,
    configuration: { baseURL: "http://127.0.0.1:9", fetch: createModelFetch(fetcher) } });
}
const music = {
  async search() { return [{ id: "quiet", title: "Quiet fixture", artist: "Fixture" }]; },
  async inspect() { return { availability: "full" as const, url: "http://127.0.0.1/fixture.mp3",
    expiresAt: Date.now() + 60000, reason: "FIXTURE" }; },
};

test("reserved tool syntax is rejected without blocking ordinary music conversation", () => {
  for (const text of [dsml, "<|DSML|function_calls>", "<｜DSML", "<｜tool▁calls▁begin｜>",
    "<tool_call>", "</function_call>"]) {
    assert.equal(hasToolProtocolText(text), true, text);
    assert.equal(spokenText(text), "");
  }
  assert.equal(spokenText("REPLY_DELIVERED"), "");
  assert.equal(hasToolProtocolText("这是 DSML 格式。"), false);
  assert.equal(spokenText("这首挺好听的。"), "这首挺好听的。");
});

for (const outcome of ["recover", "persistent"] as const) {
  test(`real SDK: queue committed, HTTP 500, text pseudo-call, bounded correction: ${outcome}`, async () => {
    const requests: any[] = [];
    const model = sdk(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const number = requests.length;
      const last = body.messages.at(-1);
      if (number === 1) return response("", "search_music", { query: "quiet", limit: 1 });
      const result = last.role === "tool" ? JSON.parse(last.content) : null;
      if (number === 2) return response("", "inspect_music", { candidateIds: [result.candidates[0].candidateId] });
      if (number === 3) return response("", "update_music_queue", {
        candidateIds: [result.results[0].candidateId], mode: "replace", timing: "after_current",
        intent: "explicit_queue", expectedQueueVersion: 0,
      });
      if (number === 4) return Response.json({ error: { message: "private-upstream" } }, { status: 500 });
      assert.equal(body.tool_choice, "none");
      assert.equal(body.tools?.length ?? 0, 0);
      const system = body.messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
      assert.match(system, /本轮没有send_message或其他工具/);
      assert.doesNotMatch(system, /全部说完后最终仅输出REPLY_DELIVERED/);
      if (number === 5 || outcome === "persistent") return response(dsml);
      assert.equal(number, 6, "Format correction must be bounded");
      return response("好，给你换些安静的。");
    });
    const lab = makeApp({ databasePath: ":memory:", music, model, modelName: "test", learning: false });
    try {
      lab.store.create("s1");
      lab.store.change("s1", state => { state.radio.current = { id: "current", title: "Current fixture", artist: "Fixture" }; });
      lab.agent.submit("s1", { requestId: "r1", clientMessageId: "m1", text: "放点安静的歌，我要工作了" });
      await lab.agent.idle();
      const state = lab.store.read("s1");
      const events = lab.store.replay("s1", 0);
      assert.equal(requests.length, 6);
      assert.equal(state.radio.current?.id, "current");
      assert.deepEqual(state.radio.queue.map(track => track.id), ["quiet"]);
      assert.equal(state.runs[0].actions?.length, 1);
      assert.equal(events.filter(event => event.type === "queue.updated").length, 1);
      assert.equal(events.filter(event => event.type === "playback.command").length, 0);
      assert.equal(events.filter(event => event.type === "reply.final").length, 1);
      assert.equal(events.some(event => JSON.stringify(event).includes("DSML")), false);
      assert.equal(state.messages.some(message => hasToolProtocolText(message.text)), false);
      assert.equal(state.runs[0].status, outcome === "recover" ? "completed" : "partial", JSON.stringify(state.runs[0]));
      assert.equal(state.messages.at(-1)?.source, outcome === "recover" ? "model" : "system");
      assert.equal(state.activeRequestId, null);
      if (outcome === "persistent") assert.equal(state.runs[0].failureCode, "MODEL_OUTPUT_PROTOCOL_ERROR");
    } finally { await lab.app.close(); }
  });
}

test("without committed actions, correction retains real tools and restores music cards", async () => {
  let calls = 0;
  const model = sdk(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    calls++;
    if (calls === 1) return response("", "search_music", { query: "quiet", limit: 1 });
    if (calls === 2) return response(dsml);
    if (calls === 3) {
      assert.equal(body.tools.some((t: any) => t.function.name === "send_message"), true);
      assert.notEqual(body.tool_choice, "none");
      assert.equal(body.messages.some((m: any) => String(m.content).includes("DSML")), false);
      const candidates = JSON.parse(body.messages.at(-1).content).candidates;
      return response("", "send_message", { text: "试试这首。", candidateIds: [candidates[0].candidateId] });
    }
    assert.equal(calls, 4);
    return response("REPLY_DELIVERED");
  });
  const lab = makeApp({ databasePath: ":memory:", music, model, modelName: "test", learning: false });
  try {
    lab.store.create("s1");
    lab.agent.submit("s1", { requestId: "r1", clientMessageId: "m1", text: "推荐一首歌" });
    await lab.agent.idle();
    const state = lab.store.read("s1");
    assert.equal(state.runs[0].status, "completed");
    assert.deepEqual(state.messages.at(-1)?.tracks?.map(t => t.id), ["quiet"]);
    assert.deepEqual(state.radio.queue, []);
    assert.equal(state.command, null);
    assert.equal(calls, 4);
  } finally { await lab.app.close(); }
});

test("invalid SDK tool arguments are not mistaken for an ordinary completed reply", async () => {
  let calls = 0;
  const model = sdk(async () => ++calls === 1 ? response("", "send_message", "{") : response("我在。"));
  const lab = makeApp({ databasePath: ":memory:", music, model, modelName: "test", learning: false });
  try {
    lab.store.create("s1");
    lab.agent.submit("s1", { requestId: "r1", clientMessageId: "m1", text: "你好" });
    await lab.agent.idle();
    assert.equal(calls, 2);
    assert.equal(lab.store.read("s1").messages.at(-1)?.text, "我在。");
    assert.equal(lab.store.replay("s1", 0).some(e => e.type === "agent.activity"), false);
  } finally { await lab.app.close(); }
});

test("message tool, automatic TTS and manual TTS all reject protocol text; archive read excludes old leaks", async () => {
  const spoken: string[] = [];
  const lab = makeApp({ databasePath: ":memory:", music, model: null, modelName: null,
    speech: { async synthesize(text) { spoken.push(text); return { bytes: Buffer.alloc(44), contentType: "audio/wav" }; } } });
  try {
    lab.store.create("s1");
    const conversation = new ConversationService(lab.store);
    assert.throws(() => conversation.send({ sessionId: "s1", requestId: "r1", controlEpoch: 0 },
      "fake", { text: dsml, candidateIds: [] }), /MODEL_OUTPUT_PROTOCOL_ERROR/);
    assert.equal(lab.store.read("s1").messages.length, 0);
    lab.speech.watch("s1");
    const message = { id: "old", role: "assistant" as const, source: "model" as const, text: dsml,
      status: "complete" as const, createdAt: new Date().toISOString() };
    lab.store.change("s1", (state, emit) => {
      state.settings.autoSpeech = true;
      state.messages.push(message);
      emit({ type: "reply.final", payload: message });
    });
    await lab.speech.idle();
    assert.deepEqual(spoken, []);
    assert.throws(() => lab.speech.replay("s1", "old"), /SPEECH_MESSAGE_NOT_FOUND/);
    lab.agent.knowledge.archive("s1", message);
    assert.equal(lab.agent.knowledge.history("").messages.some(m => m.id === "old"), false);
    assert.equal(hiddenReplyText.includes("DSML"), false);
  } finally { await lab.app.close(); }
});

for (const source of ["saved-chat", "graph-checkpoint"] as const) {
test(`leaked historical reply excluded from model input without deleting the record: ${source}`, async () => {
  const model = sdk(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(JSON.stringify(body.messages).includes("DSML"), false);
    return response("我在。");
  });
  const lab = makeApp({ databasePath: ":memory:", music, model, modelName: "test", learning: false });
  try {
    lab.store.create("s1");
    lab.store.change("s1", state => {
      state.messages.push({ id: "old", role: "assistant", source: "model", text: dsml,
        status: "complete", createdAt: new Date().toISOString() });
      state.rebuildThread = source === "saved-chat";
    });
    if (source === "graph-checkpoint") await lab.agent.graph!.updateState(
      { configurable: { thread_id: "s1:0" } }, { messages: [new AIMessage({ id: "old", content: dsml })] });
    lab.agent.submit("s1", { requestId: "r1", clientMessageId: "m1", text: "还在吗" });
    await lab.agent.idle();
    assert.equal(lab.store.read("s1").messages[0].text, dsml);
    assert.equal(lab.store.read("s1").runs[0].status, "completed");
  } finally { await lab.app.close(); }
});
}
