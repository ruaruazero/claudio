import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceConfiguration } from "./service-config.js";
import { makeApp } from "./http.js";
import { serviceIssue } from "./incidents.js";

test("service keys are encrypted, never returned, survive restart and can be removed independently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claudio-config-"));
  const defaults = { model: "deepseek-flash", speechModel: "mimo-v2.5-tts", baseURL: "https://api.deepseek.com", voice: "mimo_default" };
  const services = new ServiceConfiguration(directory, defaults);
  const lab = makeApp({ databasePath: ":memory:", model: null, modelName: null, services,
    music: { async search() { return []; }, async inspect() { throw new Error("not used"); } } });
  const headers = { host: "127.0.0.1:8081", origin: "http://127.0.0.1:5180" };
  try {
    lab.store.create("config-test");
    const patch = (payload: object) => lab.app.inject({ method: "PATCH", url: "/api/lab/services", headers, payload });
    const response = await patch({ service: "model", model: "deepseek-flash", apiKey: "test-secret-key" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().model.configured, true);
    assert.ok(!response.body.includes("test-secret-key"));
    assert.ok(!readFileSync(join(directory, "ai-services.enc")).includes(Buffer.from("test-secret-key")));
    assert.equal(statSync(join(directory, "ai-services.enc")).mode & 0o777, 0o600);
    assert.equal(new ServiceConfiguration(directory, defaults).status().model.configured, true);
    assert.ok(lab.agent.graph);
    const health = await lab.app.inject({ url: "/api/lab/health" });
    assert.equal(health.json().modelConfigured, true);
    assert.equal((await patch({ service: "speech", model: "mimo-v2.5-tts", apiKey: "test-speech-secret" })).statusCode, 200);
    assert.ok(lab.speech.provider);
    assert.equal((await patch({ service: "model", model: "deepseek-flash", clearKey: true })).statusCode, 200);
    assert.equal(lab.agent.model, null);
    assert.ok(lab.speech.provider);
    assert.equal(services.status().speech.configured, true);
    assert.equal((await patch({ service: "speech", model: "mimo-v2.5-tts", apiKey: "bad\nkey" })).statusCode, 400);
    assert.equal((await lab.app.inject({ method: "PATCH", url: "/api/lab/services", headers: { host: "evil.test", origin: headers.origin },
      payload: { service: "model", model: "test", apiKey: "test" } })).statusCode, 403);
    assert.equal((await lab.app.inject({ url: "/api/lab/services", headers: { ...headers, origin: "https://evil.test" } })).statusCode, 403);
    assert.equal((await lab.app.inject({ url: "/api/lab/services", headers })).headers["cache-control"], "no-store");
    const verify = await lab.app.inject({ method: "POST", url: "/api/lab/services/verify", headers, payload: { service: "model" } });
    assert.equal(verify.statusCode, 502);
    assert.equal(verify.json().error, "MODEL_CONFIGURATION");
    lab.store.updateServiceIssue("config-test", "speech", serviceIssue("speech", "TTS_BALANCE"));
    services.verify = async () => ({ verified: true });
    const success = await lab.app.inject({ method: "POST", url: "/api/lab/services/verify", headers, payload: { service: "speech" } });
    assert.equal(success.statusCode, 200);
    assert.equal(lab.store.serviceIssues().length, 0);
  } finally { await lab.app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("verification calls the provider only explicitly and sanitizes failed responses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claudio-verify-"));
  const services = new ServiceConfiguration(directory, { modelKey: "secret-never-return", model: "deepseek-flash",
    speechModel: "mimo-v2.5-tts", baseURL: "https://api.deepseek.com", voice: "mimo_default" });
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { message: "secret-never-return" } }), { status: 402, headers: { "content-type": "application/json" } }); };
  try {
    services.prepare({ service: "model", model: "deepseek-flash" }).commit();
    assert.equal(calls, 0);
    await assert.rejects(services.verify("model"), error => error instanceof Error && error.message === "MODEL_BALANCE");
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; rmSync(directory, { recursive: true, force: true }); }
});
