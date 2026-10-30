import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { makeApp } from "./http.js";
import { readCommand } from "./playback-journal.js";
import type { Music } from "./music.js";
import type { PlaybackAck, Track } from "../src/protocol.js";

const tracks: Track[] = [
  { id: "one", title: "One", artist: "Fixture" },
  { id: "two", title: "Two", artist: "Fixture" },
];
const music: Music = {
  async search() { return tracks; },
  async inspect() { return { availability: "full", url: "http://localhost/test.wav",
    expiresAt: Date.now() + 120_000, reason: "fixture" }; },
};
function fixture(t: TestContext) {
  const lab = makeApp({ databasePath: ":memory:", model: null, modelName: null, music, ackTimeoutMs: 5 });
  t.after(() => lab.app.close());
  lab.store.create("s1");
  lab.store.change("s1", state => { state.radio.current = tracks[0]; state.radio.queue = [tracks[1]]; });
  return lab;
}
type Lab = ReturnType<typeof fixture>;
function ack(lab: Lab, status: PlaybackAck["status"], ackSequence = 1): PlaybackAck {
  const command = lab.store.read("s1").command!;
  return { commandId: command.commandId, playbackVersion: command.playbackVersion,
    trackId: command.track?.id, status, ackSequence, positionMs: 1000 };
}

test("command wait timeout preserves a committed operation and a late ACK settles it without replay", async t => {
  const lab = fixture(t);
  const accepted = await lab.radio.control({ action: "play", expectedPlaybackVersion: 0 }, "s1", "play");
  const pending = await lab.commands.waitForResult("s1", accepted) as Record<string, unknown>;
  assert.equal(pending.playbackOutcome, "pending");
  assert.equal(pending.retryable, false);
  lab.commands.observe("s1", ack(lab, "playing"));
  assert.equal(lab.commands.result("s1", pending.commandId as string).playbackOutcome, "playing");
  assert.equal(lab.store.replay("s1", 0).filter(e => e.type === "playback.command").length, 1);
});

test("cancelling a waiter removes its subscription while the committed command continues", async t => {
  const lab = fixture(t);
  const accepted = await lab.radio.control({ action: "play", expectedPlaybackVersion: 0 }, "s1", "play");
  let subscriptions = 0;
  const subscribe = lab.store.subscribe.bind(lab.store);
  lab.store.subscribe = (id, listener) => {
    subscriptions++;
    const unsubscribe = subscribe(id, listener);
    return () => { subscriptions--; unsubscribe(); };
  };
  const controller = new AbortController();
  const waiting = lab.commands.waitForResult("s1", accepted, controller.signal);
  const rejected = assert.rejects(waiting, /cancelled/);
  controller.abort(new Error("cancelled"));
  await rejected;
  assert.equal(subscriptions, 0);
  lab.commands.observe("s1", ack(lab, "playing"));
  assert.equal(lab.store.read("s1").desiredPlayback, "play");
  assert.equal(lab.commands.result("s1", lab.store.read("s1").command!.commandId).playbackOutcome, "playing");
});

test("an ACK arriving before a waiter is not lost", async t => {
  const lab = fixture(t);
  const accepted = await lab.radio.control({ action: "play", expectedPlaybackVersion: 0 }, "s1", "play");
  lab.commands.observe("s1", ack(lab, "playing"));
  const outcome = await lab.commands.waitForResult("s1", accepted) as Record<string, unknown>;
  assert.equal(outcome.playbackOutcome, "playing");
});

test("superseding a pending command cannot erase a different completed command", async t => {
  const lab = fixture(t);
  await lab.radio.control({ action: "play", expectedPlaybackVersion: 0 }, "s1", "first");
  const first = ack(lab, "playing");
  lab.commands.observe("s1", first);
  await lab.radio.control({ action: "pause", expectedPlaybackVersion: 1 }, "s1", "second");
  const second = lab.store.read("s1").command!;
  await lab.radio.control({ action: "next", expectedPlaybackVersion: 2 }, "s1", "third");
  assert.equal(lab.commands.result("s1", first.commandId).playbackOutcome, "playing");
  assert.equal(lab.commands.result("s1", second.commandId).playbackOutcome, "superseded");
  const before = lab.store.read("s1");
  assert.throws(() => lab.commands.observe("s1", { ...first, ackSequence: 2 }), /STALE_PLAYBACK_ACK/);
  assert.deepEqual(lab.store.read("s1"), before);
});

test("command completion stays settled when the same media later buffers or ends", async t => {
  const lab = fixture(t);
  await lab.radio.control({ action: "play", expectedPlaybackVersion: 0 }, "s1", "play");
  const playing = ack(lab, "playing");
  lab.commands.observe("s1", playing);
  lab.commands.observe("s1", ack(lab, "loading", 2));
  assert.equal(lab.radio.state("s1").playback.status, "loading");
  assert.equal(lab.commands.result("s1", playing.commandId).playbackOutcome, "playing");
  assert.equal(lab.store.read("s1").commandProgress?.phase, "succeeded");
  lab.commands.observe("s1", ack(lab, "ended", 3));
  assert.equal(lab.store.read("s1").commandProgress?.phase, "succeeded");
  assert.equal(lab.radio.state("s1").playback.status, "ended");
  assert.equal(lab.radio.state("s1").command?.status, "succeeded");
  assert.equal(readCommand(lab.store.db, "s1", playing.commandId)?.completion?.status, "playing");
});

test("out-of-order progress and duplicated end reports neither regress nor duplicate effects", async t => {
  const lab = fixture(t);
  await lab.radio.control({ action: "play", expectedPlaybackVersion: 0 }, "s1", "play");
  const playing = ack(lab, "playing");
  lab.commands.receive("s1", { ...playing, phase: "executing" });
  lab.commands.receive("s1", { ...playing, phase: "received" });
  assert.equal(lab.store.read("s1").commandProgress?.phase, "executing");
  lab.commands.observe("s1", playing);
  assert.equal(lab.commands.observe("s1", ack(lab, "loading", 0)), false);
  lab.commands.observe("s1", ack(lab, "ended", 2));
  const sequence = lab.store.read("s1").lastSequence;
  assert.equal(lab.commands.observe("s1", ack(lab, "ended", 3)), false);
  assert.equal(lab.store.read("s1").lastSequence, sequence);
  assert.equal(lab.store.read("s1").maintenance.endedCount, 1);
  assert.equal(lab.agent.knowledge.listening().filter(item => item.action === "completed").length, 1);
});

test("ACK state, command history and listening evidence roll back together on a write failure", async t => {
  const lab = fixture(t);
  await lab.radio.control({ action: "play", expectedPlaybackVersion: 0 }, "s1", "play");
  const before = lab.store.read("s1");
  const listen = lab.agent.knowledge.listen.bind(lab.agent.knowledge);
  lab.agent.knowledge.listen = () => { throw new Error("fixture write failure"); };
  assert.throws(() => lab.commands.observe("s1", ack(lab, "ended")), /fixture write failure/);
  assert.deepEqual(lab.store.read("s1"), before);
  assert.equal(readCommand(lab.store.db, "s1", before.command!.commandId)?.completion, null);
  lab.agent.knowledge.listen = listen;
  lab.commands.observe("s1", ack(lab, "ended"));
  assert.equal(lab.agent.knowledge.listening().length, 1);
});

test("idempotency rejects reuse with a different operation and failed writes release their binding", async t => {
  const lab = fixture(t);
  await lab.radio.control({ action: "pause", expectedPlaybackVersion: 0 }, "s1", "operation");
  await assert.rejects(lab.radio.control({ action: "stop", expectedPlaybackVersion: 0 }, "s1", "operation"),
    /IDEMPOTENCY_CONFLICT/);
  const before = lab.store.read("s1");
  lab.store.change("s1", state => { state.activeRequestId = "r1"; });
  const context = { sessionId: "s1", requestId: "r1" };
  assert.throws(() => lab.radio.updateQueue({ candidateIds: ["missing"], mode: "replace", timing: "now",
    expectedQueueVersion: 0 }, context, "retry"), /CANDIDATE_NOT_IN_THIS_REQUEST/);
  const bindings = lab.store.db.prepare("SELECT COUNT(*) AS count FROM lab_operation_inputs WHERE operation_id='retry'")
    .get() as { count: number };
  assert.equal(bindings.count, 0);
  assert.equal(lab.store.read("s1").radio.playbackVersion, before.radio.playbackVersion);
});

test("restart retains historical outcomes, interrupts pending commands and never replays them", async t => {
  const lab = fixture(t);
  await lab.radio.control({ action: "play", expectedPlaybackVersion: 0 }, "s1", "first");
  const first = ack(lab, "playing");
  lab.commands.observe("s1", first);
  await lab.radio.control({ action: "pause", expectedPlaybackVersion: 1 }, "s1", "second");
  const pending = lab.store.read("s1").command!;
  const sequence = lab.store.read("s1").lastSequence;
  lab.store.recover();
  assert.equal(lab.store.read("s1").command, null);
  assert.equal(lab.commands.result("s1", first.commandId).playbackOutcome, "playing");
  assert.equal(lab.commands.result("s1", pending.commandId).playbackOutcome, "interrupted");
  assert.equal(lab.store.replay("s1", sequence).filter(e => e.type === "playback.command").length, 0);
});

test("reattach adopts actual browser state after restart without sending a play command", async t => {
  const lab = fixture(t);
  await lab.radio.control({ action: "play", expectedPlaybackVersion: 0 }, "s1", "play");
  const actual = ack(lab, "playing");
  lab.commands.observe("s1", actual);
  lab.store.recover();
  const sequence = lab.store.read("s1").lastSequence;
  const response = await lab.app.inject({ method: "POST", url: "/api/lab/sessions/s1/player/attach",
    payload: { observation: { ...actual, positionMs: 42_000 } } });
  assert.equal(response.statusCode, 200);
  const { reconciled } = response.json();
  assert.ok(reconciled);
  assert.notEqual(reconciled.commandId, actual.commandId);
  assert.equal(reconciled.playbackVersion, 2);
  assert.equal(lab.radio.state("s1").playback.lastReportedPositionMs, 42_000);
  assert.equal(lab.store.replay("s1", sequence).filter(e => e.type === "playback.command").length, 0);
  assert.throws(() => lab.commands.observe("s1", { ...actual, ackSequence: 99 }), /STALE_PLAYBACK_ACK/);
  lab.commands.observe("s1", { ...actual, ...reconciled, ackSequence: 2, positionMs: 45_000 });
  assert.equal(lab.radio.state("s1").playback.lastReportedPositionMs, 45_000);
});

test("reattach cannot adopt a different track or overwrite a newer command", async t => {
  const lab = fixture(t);
  await lab.radio.control({ action: "play", expectedPlaybackVersion: 0 }, "s1", "play");
  const actual = ack(lab, "playing");
  lab.store.recover();
  assert.equal(lab.commands.attach("s1", { ...actual, trackId: "forged" }).reconciled, null);
  assert.equal(lab.store.read("s1").command, null);
  await lab.radio.control({ action: "pause", expectedPlaybackVersion: 1 }, "s1", "pause");
  assert.equal(lab.commands.attach("s1", actual).reconciled, null);
  assert.equal(lab.store.read("s1").command?.action, "pause");
});

test("reattach preserves an explicit pause and defers a still-buffering player", async t => {
  const lab = fixture(t);
  await lab.radio.control({ action: "play", expectedPlaybackVersion: 0 }, "s1", "play");
  const loading = ack(lab, "loading");
  lab.store.recover();
  assert.equal(lab.commands.attach("s1", loading).reconciled, null);
  assert.equal(lab.store.read("s1").command, null);
  await lab.radio.control({ action: "pause", expectedPlaybackVersion: 1 }, "s1", "pause");
  const paused = ack(lab, "paused");
  lab.commands.observe("s1", paused);
  lab.store.recover();
  const attached = lab.commands.attach("s1", paused);
  assert.ok(attached.reconciled);
  assert.equal(lab.store.read("s1").desiredPlayback, "pause");
  assert.equal(lab.store.read("s1").command?.action, "pause");
  assert.equal(lab.radio.state("s1").playback.status, "paused");
});

test("local control cannot reuse a historical command ID from the Agent path", async t => {
  const lab = fixture(t);
  await lab.radio.control({ action: "play", expectedPlaybackVersion: 0 }, "s1", "play");
  const command = lab.store.read("s1").command!;
  const before = lab.store.read("s1");
  assert.throws(() => lab.resources.observeLocal("s1", { commandId: command.commandId,
    action: "pause", expectedPlaybackVersion: 1 }), /IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(lab.store.read("s1"), before);
  assert.equal(lab.agent.knowledge.listening().length, 0);
});

test("local queue advancement and its evidence either both commit or both roll back", async t => {
  const lab = fixture(t);
  await lab.resources.refresh("s1");
  const before = lab.store.read("s1");
  const input = { commandId: "local-next", action: "next" as const,
    expectedPlaybackVersion: 0, trackId: tracks[1].id };
  const listen = lab.agent.knowledge.listen.bind(lab.agent.knowledge);
  lab.agent.knowledge.listen = () => { throw new Error("fixture write failure"); };
  assert.throws(() => lab.resources.observeLocal("s1", input), /fixture write failure/);
  assert.deepEqual(lab.store.read("s1"), before);
  assert.equal(readCommand(lab.store.db, "s1", input.commandId), null);
  lab.agent.knowledge.listen = listen;
  lab.resources.observeLocal("s1", input);
  lab.resources.observeLocal("s1", input);
  assert.equal(lab.store.read("s1").radio.current?.id, tracks[1].id);
  assert.equal(lab.agent.knowledge.listening().length, 1);
  assert.equal(lab.agent.knowledge.listening()[0].track.id, tracks[0].id);
});

test("command journal persists after reopening SQLite and omits playable resource URLs", async t => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "claudio-commands-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = { databasePath: join(dir, "state.sqlite"), model: null, modelName: null, music };
  const first = makeApp(options);
  first.store.create("s1");
  first.store.change("s1", state => { state.radio.current = tracks[0]; });
  await first.radio.control({ action: "play", expectedPlaybackVersion: 0 }, "s1", "play");
  const command = first.store.read("s1").command!;
  first.commands.observe("s1", { commandId: command.commandId, playbackVersion: 1,
    ackSequence: 1, trackId: tracks[0].id, status: "playing", positionMs: 100 });
  await first.app.close();
  const second = makeApp(options);
  try {
    assert.equal(second.commands.result("s1", command.commandId).playbackOutcome, "playing");
    assert.equal(JSON.stringify(readCommand(second.store.db, "s1", command.commandId)).includes("http://localhost"), false);
  } finally { await second.app.close(); }
});
