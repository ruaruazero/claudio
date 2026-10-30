import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp } from "../server/http.js";
import { MockMusic } from "../server/mock-music.js";

// Uses an isolated database, local test audio and fake TTS; no provider calls.
const port = 18083;
const base = `http://127.0.0.1:${port}`;
const music = new MockMusic(base);
const directory = mkdtempSync(join(tmpdir(), "claudio-browser-playback-"));
const options = { databasePath: join(directory, "state.sqlite"), music, model: null, modelName: null,
  learning: false, musicProvider: "mock" as const, speech: {
    async synthesize() { throw new Error("Streaming fixture only"); },
    async *stream() { yield Buffer.alloc(24000 * 2); },
  } };
let lab = makeApp(options);
const sessionId = "browser-playback-regression";
const tracks = await music.search("focus high", 6, new AbortController().signal);
lab.store.create(sessionId);
lab.store.change(sessionId, state => {
  state.radio.current = tracks[0];
  state.radio.queue = tracks.slice(1);
  state.settings.autoSpeech = true;
  state.settings.proactive = false;
});
await lab.app.listen({ host: "127.0.0.1", port });
const { chromium } = await import("@playwright/test");
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH,
  headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (error: Error) => errors.push(error.message));
try {
  await page.addInitScript(({ base, sessionId }: { base: string; sessionId: string }) => {
    localStorage.setItem("claudio-lab-preferences", JSON.stringify({ backend: `${base}/api/lab`,
      settings: { autoSpeech: false, proactive: false, allowPreview: true }, volume: 0 }));
    const db = indexedDB.open("claudio-agent-lab", 1);
    db.onupgradeneeded = () => {
      db.result.createObjectStore("sessions", { keyPath: "id" });
      db.result.createObjectStore("meta");
    };
    db.onsuccess = () => {
      const tx = db.result.transaction(["sessions", "meta"], "readwrite");
      tx.objectStore("sessions").put({ id: sessionId, serverSessionId: sessionId,
        backend: `${base}/api/lab`, draft: "", messages: [], events: [], lastSequence: 0, createdAt: new Date().toISOString() });
      tx.objectStore("meta").put(sessionId, "currentSession");
      tx.oncomplete = () => db.result.close();
    };
    (window as unknown as { mediaEvents: unknown[] }).mediaEvents = [];
    const originalPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function () {
      (window as unknown as { mediaEvents: unknown[] }).mediaEvents.push({
        type: "pause-called", src: this.getAttribute("src"), time: this.currentTime,
        at: performance.now(), stack: new Error().stack });
      return originalPause.call(this);
    };
    for (const type of ["pause", "playing", "emptied", "loadstart"]) document.addEventListener(type, event => {
      const el = event.target;
      if (el instanceof HTMLMediaElement) (window as unknown as { mediaEvents: unknown[] }).mediaEvents.push({
        type, src: el.getAttribute("src"), paused: el.paused, time: el.currentTime, at: performance.now() });
    }, true);
  }, { base, sessionId });
  await page.goto("http://127.0.0.1:5180/");
  await page.waitForFunction(() => [...document.querySelectorAll("audio")].some(el => !el.paused && el.currentTime > 0.2));
  assert.equal(lab.store.read(sessionId).settings.autoSpeech, true,
    "An obsolete browser default must not turn off confirmed automatic speech");
  for (let index = 0; index < 4; index++) {
    const current = lab.store.read(sessionId);
    const requestId = `replace-${index}`;
    const selected = tracks[(index + 1) % tracks.length];
    const resource = await music.inspect(selected, new AbortController().signal);
    const candidateId = randomUUID();
    lab.store.change(sessionId, state => {
      state.activeRequestId = requestId;
      state.candidates.push({ id: candidateId, requestId, track: selected, resource });
    });
    lab.agent.updateQueue({ candidateIds: [candidateId], mode: "replace", timing: index % 2 ? "after_current" : "now",
      expectedQueueVersion: current.radio.queueVersion, intent: "explicit_queue" },
    { sessionId, requestId, controlEpoch: current.controlEpoch }, requestId);
    lab.store.change(sessionId, state => { state.activeRequestId = null; });
    await page.waitForTimeout(1000);
    const state = lab.store.read(sessionId);
    assert.equal(state.desiredPlayback, "play", `Queue replacement ${index} must not produce a local pause`);
    assert.equal(state.playbackAck?.status, "playing", `Queue replacement ${index} must remain playing`);
  }
  const messageId = randomUUID();
  lab.store.change(sessionId, (state, emit) => {
    const message = { id: messageId, role: "assistant" as const, source: "model" as const,
      text: "我们接着聊。", status: "complete" as const, createdAt: new Date().toISOString() };
    state.messages.push(message);
    emit({ type: "reply.final", payload: message });
  });
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === "SPEAKING", { timeout: 10000 });
  await page.waitForTimeout(1500);
  assert.ok(lab.store.replay(sessionId, 0).some(event =>
    event.type === "speech.observed" && event.payload.status === "playing"), "Automatic TTS must report playing");
  // A real external pause must still be recorded and retain the playback position.
  const position = await page.evaluate(() => {
    const audio = [...document.querySelectorAll("audio")].find(el => !el.paused)!;
    const seconds = audio.currentTime;
    audio.pause();
    return seconds;
  });
  await page.waitForFunction(() => [...document.querySelectorAll("audio")].every(el => el.paused));
  await page.waitForTimeout(500);
  assert.equal(lab.store.read(sessionId).desiredPlayback, "pause");
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await page.waitForFunction((seconds: number) =>
    [...document.querySelectorAll("audio")].some(el => !el.paused && el.currentTime >= seconds), position);
  assert.equal(lab.store.read(sessionId).desiredPlayback, "play");
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, "Browser must reconcile playback after automatic reconnect");
      await page.waitForTimeout(100);
    }
  };
  for (const paused of [false, true]) {
    if (paused) {
      await page.getByRole("button", { name: "暂停", exact: true }).click();
      await waitFor(() => lab.store.read(sessionId).playbackAck?.status === "paused");
    }
    const before = await page.evaluate(() => {
      const audio = [...document.querySelectorAll("audio")].find(el => Boolean(el.getAttribute("src")) && el.currentTime > 0)!;
      return { time: audio.currentTime, src: audio.getAttribute("src"),
        eventCount: (window as unknown as { mediaEvents: unknown[] }).mediaEvents.length };
    });
    const commandId = lab.store.read(sessionId).command!.commandId;
    const sequence = lab.store.read(sessionId).lastSequence;
    await lab.app.close();
    lab = makeApp(options);
    await lab.app.listen({ host: "127.0.0.1", port });
    await waitFor(() => {
      const state = lab.store.read(sessionId);
      return Boolean(state.command && state.command.commandId !== commandId &&
        state.playbackAck?.status === (paused ? "paused" : "playing"));
    });
    const after = await page.evaluate(() => [...document.querySelectorAll("audio")]
      .filter(el => Boolean(el.getAttribute("src")) && el.currentTime > 0)
      .map(el => ({ time: el.currentTime, src: el.getAttribute("src"), paused: el.paused })));
    const active = after.find(el => el.src === before.src)!;
    assert.ok(active, "Reconciliation must retain the loaded media source");
    assert.equal(active.paused, paused);
    if (paused) assert.ok(Math.abs(active.time - before.time) < 0.1, "Reconnect must preserve a paused position");
    else assert.ok(active.time > before.time, "Music must continue through the local backend restart");
    assert.equal(lab.store.replay(sessionId, sequence).filter(e => e.type === "playback.command").length, 0,
      "Reconciliation must never replay a media command");
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, replacements: 4, autoSpeech: true, backendRestarts: 2,
    observations: lab.store.replay(sessionId, 0).filter(event =>
      event.type === "playback.observed" || event.type === "speech.observed") }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ media: await page.evaluate(() => (window as unknown as { mediaEvents: unknown[] }).mediaEvents),
    events: lab.store.replay(sessionId, 0).filter(event =>
      ["settings.updated", "playback.observed", "speech.observed", "speech.failed"].includes(event.type)), errors }, null, 2));
  throw error;
} finally { await browser.close(); await lab.app.close(); rmSync(directory, { recursive: true, force: true }); }
