import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp } from "./http.js";
import { MockMusic } from "./mock-music.js";
import { MusicCredentials } from "./music-account.js";
import { ServiceConfiguration } from "./service-config.js";
import { desktopTestDirectory } from "../desktop/test-mode.js";

test("desktop fixture encryption is gated by explicit test mode and an isolated temporary directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "claudio-desktop-test-"));
  const other = mkdtempSync(join(tmpdir(), "claudio-private-"));
  try {
    const args = [`--claudio-test-data=${directory}`];
    assert.throws(() => desktopTestDirectory(args, {}), /not enabled/);
    assert.equal(desktopTestDirectory(args, { CLAUDIO_DESKTOP_TEST: "1" }), realpathSync(directory));
    assert.throws(() => desktopTestDirectory([`--claudio-test-data=${other}`], { CLAUDIO_DESKTOP_TEST: "1" }),
      /isolated temporary/);
    assert.equal(desktopTestDirectory([], {}), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

test("desktop service requires the private launch token, including health and settings", async () => {
  const lab = makeApp({ databasePath: ":memory:", model: null, modelName: null, learning: false,
    music: new MockMusic("http://127.0.0.1"), desktopToken: "private-launch-token" });
  try {
    for (const url of ["/api/lab/health", "/api/lab/services"]) {
      assert.equal((await lab.app.inject({ url })).statusCode, 403);
      assert.equal((await lab.app.inject({ url, headers: { "x-claudio-token": "wrong" } })).statusCode, 403);
    }
    const headers = { "x-claudio-token": "private-launch-token" };
    assert.equal((await lab.app.inject({ url: "/api/lab/health", headers })).statusCode, 200);
    assert.equal((await lab.app.inject({ url: "/api/lab/health", headers: { ...headers, origin: "https://evil.test" } })).statusCode, 403);
  } finally { await lab.app.close(); }
});

test("desktop credential codec persists and restores without generating a local AES key", () => {
  const directory = mkdtempSync(join(tmpdir(), "claudio-codec-"));
  // Verify codec delegation; production encryption comes from OS safeStorage.
  const codec = { encryptString: (value: string) => Buffer.from(value.split("").reverse().join("")),
    decryptString: (value: Buffer) => value.toString().split("").reverse().join("") };
  try {
    const defaults = { model: "deepseek-flash", speechModel: "mimo-v2.5-tts",
      baseURL: "https://api.deepseek.com", voice: "mimo_default" };
    const config = new ServiceConfiguration(directory, defaults, codec);
    config.prepare({ service: "model", model: "deepseek-flash", apiKey: "test-secret" }).commit();
    assert.equal(readdirSync(directory).some(file => file.endsWith(".key")), false);
    assert.equal(readFileSync(join(directory, "ai-services.enc")).includes(Buffer.from("test-secret")), false);
    assert.equal(new ServiceConfiguration(directory, defaults, codec).status().model.configured, true);
    const music = new MusicCredentials(directory, "music", codec);
    music.save("cookie-fixture");
    assert.equal(new MusicCredentials(directory, "music", codec).read(), "cookie-fixture");
    music.clear();
    assert.equal(music.read(), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
