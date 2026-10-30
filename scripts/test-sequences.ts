import assert from "node:assert/strict";
import { makeApp } from "../server/http.js";
import { MockMusic } from "../server/mock-music.js";

const lab = makeApp({ databasePath: ":memory:", music: new MockMusic("http://127.0.0.1:9876"),
  model: null, modelName: null });
let seed = 20261026;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const counts = { play: 0, pause: 0, stop: 0, next: 0, select: 0, stale: 0, duplicate: 0 };
try {
  const tracks = await new MockMusic("http://127.0.0.1:9876").search("安静 high", 6, new AbortController().signal);
  lab.store.create("sequence");
  lab.store.change("sequence", (state) => {
    state.radio.current = tracks[0]; state.radio.queue = tracks.slice(1);
    state.messages.push({ id: "cards", role: "assistant", source: "model", text: "推荐",
      tracks, status: "complete", createdAt: new Date().toISOString() });
  });
  let queueChanges = 0;
  for (let index = 0; index < 500; index++) {
    // Replenishment and local controls interleave without a model or external service.
    if (lab.store.read("sequence").radio.queue.length < 2) {
      lab.store.change("sequence", (state, emit) => {
        state.radio.queue.push(...tracks.filter((t) => t.id !== state.radio.current?.id));
        state.radio.queueVersion++; queueChanges++;
        emit({ type: "queue.updated", payload: state.radio });
      });
    }
    await lab.resources.refresh("sequence");
    const before = lab.store.read("sequence");
    const action = (["play", "pause", "stop", "next", "select"] as const)[Math.floor(random() * 5)];
    const selected = action === "select" ? tracks[Math.floor(random() * tracks.length)]
      : action === "next" ? before.radio.queue[0] : before.radio.current;
    const operation = { commandId: `operation-${index}`, action, expectedPlaybackVersion: before.radio.playbackVersion,
      ...(selected ? { trackId: selected.id } : {}), ...(action === "select" ? { messageId: "cards" } : {}) };
    const url = "/api/lab/sessions/sequence/playback/local";
    const response = await lab.app.inject({ method: "POST", url, payload: operation });
    assert.equal(response.statusCode, 200, `Step ${index}: ${action}`);
    counts[action]++;
    const after = lab.store.read("sequence");
    assert.equal(after.radio.playbackVersion, before.radio.playbackVersion + 1);
    assert.equal(after.command?.action, ["next", "select", "play"].includes(action) ? "play" : action);
    if (action !== "next") {
      assert.deepEqual(after.radio.queue, before.radio.queue);
      assert.equal(after.radio.queueVersion, before.radio.queueVersion);
    } else {
      assert.deepEqual(after.radio.queue, before.radio.queue.slice(1));
    }
    if (index % 7 === 0) {
      const replay = await lab.app.inject({ method: "POST", url, payload: operation });
      assert.equal(replay.statusCode, 200);
      assert.deepEqual(lab.store.read("sequence").radio, after.radio, "Duplicate delivery must not advance twice");
      counts.duplicate++;
    }
    if (index % 11 === 0) {
      const stale = await lab.app.inject({ method: "POST", url,
        payload: { ...operation, commandId: `stale-${index}` } });
      assert.equal(stale.statusCode, 409);
      assert.deepEqual(lab.store.read("sequence").radio, after.radio, "Stale commands cannot change the queue");
      counts.stale++;
    }
  }
  assert.ok(!lab.store.replay("sequence", 0).some((e) => e.type === "playback.command"),
    "Local player synchronization must not echo remote commands");
  console.log(JSON.stringify({ passed: true, steps: 500, seed: 20261026, queueChanges, counts,
    boundary: "HTTP/state-machine sequence test; synthetic resources; no browser or real audio hardware." }));
} finally { await lab.app.close(); }
