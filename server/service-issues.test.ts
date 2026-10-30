import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatDeepSeek } from "@langchain/deepseek";
import { makeApp } from "./http.js";
import { createModelFetch } from "./model-network.js";
import { failureOutcome, serviceIssue } from "./incidents.js";
import { Store, Fault } from "./store.js";

const music = { async search() { return []; }, async inspect() { throw new Error("unused"); } };
const ok = () => new Response(JSON.stringify({
  id: "test", object: "chat.completion", created: 1, model: "test",
  choices: [{ index: 0, message: { role: "assistant", content: "我在。" }, finish_reason: "stop" }],
}), { headers: { "Content-Type": "application/json" } });
for (const [status, code, phrase] of [
  [402, "MODEL_BALANCE", "余额不足"], [401, "MODEL_AUTH_FAILED", "认证失败"],
  [403, "MODEL_PERMISSION_DENIED", "拒绝访问"], [404, "MODEL_NOT_FOUND", "找不到"],
  [422, "MODEL_PROTOCOL_ERROR", "请求参数"],
] as const) {
  test(`external model issue ${status} is actionable, durable and clears only on provider success`, async () => {
    let available = false;
    let calls = 0;
    const model = new ChatDeepSeek({ apiKey: "PRIVATE_KEY", model: "test", maxRetries: 0,
      configuration: { fetch: createModelFetch(async () => {
        calls++;
        return available ? ok() : new Response(JSON.stringify({ error: {
          message: "PRIVATE_PROVIDER_BODY", code: "PRIVATE_DETAIL",
        } }), { status });
      }) } });
    const { app, store, agent } = makeApp({ databasePath: ":memory:", music, model, modelName: "test" });
    try {
      store.create("s1");
      agent.submit("s1", { requestId: "r1", clientMessageId: "m1", text: "你好" });
      await agent.idle();
      assert.equal(calls, 1);
      const result = store.replay("s1", 0).find((e) => e.type === "run.failed");
      assert.ok(result?.type === "run.failed");
      assert.equal(result.payload.code, code);
      assert.equal(result.payload.incident?.visibility, "banner");
      assert.equal(result.payload.incident?.recovery, "configure");
      assert.match(result.payload.message!, new RegExp(phrase));
      const snapshot = (await app.inject({ url: "/api/lab/sessions/s1" })).json();
      assert.equal(snapshot.serviceIssues[0].code, code);
      store.change("s1", (s) => { s.maintenance.lastInputAt = 0; });
      await agent.maintain("s1"); await agent.idle();
      assert.equal(calls, 1, "Background refill must not keep requesting a service requiring user action");
      store.create("s2");
      assert.equal(store.snapshot(store.read("s2")).serviceIssues[0].code, code);
      assert.ok(!JSON.stringify(store.replay("s1", 0)).includes("PRIVATE"));
      available = true;
      agent.submit("s1", { requestId: "r2", clientMessageId: "m2", text: "再试一次" });
      await agent.idle();
      assert.equal(store.read("s1").runs.at(-1)?.status, "completed");
      assert.deepEqual(store.snapshot(store.read("s1")).serviceIssues, []);
      assert.deepEqual(store.snapshot(store.read("s2")).serviceIssues, []);
      assert.ok(store.replay("s1", 0).some((e) => e.type === "service.updated" && e.payload.issue === null));
    } finally { await app.close(); }
  });
}

test("a committed successful playback cannot hide a provider balance problem", () => {
  const store = new Store(":memory:");
  try {
    store.create("s1");
    store.change("s1", (s) => {
      s.runs.push({ requestId: "r1", clientMessageId: "m1", text: "play", status: "running",
        actions: [{ operationId: "op", commandId: "cmd", kind: "playback", action: "play",
          trackTitle: "Moon Song", queueVersion: 0, playbackVersion: 0 }] });
      s.command = { commandId: "cmd", action: "play", playbackVersion: 0, expiresAt: new Date().toISOString() };
      s.playbackAck = { commandId: "cmd", playbackVersion: 0, ackSequence: 1, status: "playing", positionMs: 0 };
    });
    const result = failureOutcome(store.read("s1"), "r1", "MODEL_BALANCE");
    assert.equal(result.committed, true);
    assert.match(result.text, /Moon Song/);
    assert.match(result.text, /余额不足/);
    assert.equal(result.incident.level, "action_required");
    assert.equal(result.incident.visibility, "banner");
  } finally { store.db.close(); }
});

test("service issues survive backend restart and duplicate failures do not spam events", () => {
  const dir = mkdtempSync(join(tmpdir(), "claudio-issues-"));
  const path = join(dir, "test.sqlite");
  let store = new Store(path);
  try {
    store.create("s1");
    store.updateServiceIssue("s1", "model", serviceIssue("model", "MODEL_BALANCE"));
    const sequence = store.read("s1").lastSequence;
    store.updateServiceIssue("s1", "model", serviceIssue("model", "MODEL_BALANCE"));
    assert.equal(store.read("s1").lastSequence, sequence);
    store.db.close();
    store = new Store(path);
    assert.equal(store.snapshot(store.read("s1")).serviceIssues[0].code, "MODEL_BALANCE");
    store.updateServiceIssue("s1", "model", null);
    assert.deepEqual(store.serviceIssues(), []);
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("speech balance failure is independent of model status and clears after successful synthesis", async () => {
  let available = false;
  const { app, store, speech } = makeApp({ databasePath: ":memory:", music, model: null, modelName: null,
    speech: { async synthesize() {
      if (!available) throw new Fault("TTS_BALANCE", 502);
      return { bytes: Buffer.alloc(44), contentType: "audio/wav" };
    } } });
  try {
    store.create("s1");
    store.change("s1", (s) => { s.settings.autoSpeech = true; });
    speech.watch("s1");
    const publish = (id: string) => store.change("s1", (_, emit) => emit({ type: "reply.final", payload: {
      id, role: "assistant", source: "model", text: "你好", status: "complete", createdAt: new Date().toISOString(),
    } }));
    publish("one"); await new Promise((r) => setImmediate(r)); await speech.idle();
    assert.equal(store.serviceIssues()[0].code, "TTS_BALANCE");
    assert.match(store.serviceIssues()[0].message, /文字聊天和音乐仍可使用/);
    store.updateServiceIssue("s1", "model", serviceIssue("model", "MODEL_AUTH_FAILED"));
    available = true;
    publish("two"); await new Promise((r) => setImmediate(r)); await speech.idle();
    assert.deepEqual(store.serviceIssues().map((i) => i.service), ["model"]);
  } finally { await app.close(); }
});
