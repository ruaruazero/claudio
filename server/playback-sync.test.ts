import assert from "node:assert/strict";
import { test } from "node:test";
import { PlaybackSync, type SyncScope } from "../src/playback-sync.js";
import type { SavedObservation, playbackReceipts } from "../src/storage.js";

function fixture() {
  let scope: SyncScope | null = { backend: "/api", sessionId: "s1" };
  let localPending = false;
  let receipts: ReturnType<typeof playbackReceipts> = [];
  let observations: SavedObservation[] = [];
  let failures = 0;
  const sent: { scope: SyncScope; path: string; body: any }[] = [];
  let send = async (_scope: SyncScope, _path: string, _body: unknown) => {};
  const service = new PlaybackSync({
    scope: () => scope,
    hasLocal: () => localPending,
    receipts: () => receipts,
    observations: () => observations,
    removeReceipt: item => { receipts = receipts.filter(value => value !== item); },
    removeObservation: item => { observations = observations.filter(value => value !== item); },
    send: async (scope, path, body) => { sent.push({ scope, path, body }); await send(scope, path, body); },
    storageFailed: () => { failures++; },
  });
  const observation = (status: "loading" | "playing" = "playing", ackSequence = 1): SavedObservation => ({
    backend: "/api", sessionId: "s1", ack: {
      commandId: "c1", playbackVersion: 1, ackSequence, status, positionMs: 100,
    },
  });
  return {
    service, sent, observation,
    get receipts() { return receipts; }, get observations() { return observations; }, get failures() { return failures; },
    addObservation: (item: SavedObservation) => { observations.push(item); },
    addReceipt: () => { receipts.push({ backend: "/api", sessionId: "s1",
      receipt: { commandId: "c1", playbackVersion: 1, phase: "executing" } }); },
    setScope: (value: SyncScope | null) => { scope = value; },
    setLocalPending: (value: boolean) => { localPending = value; },
    setSend: (value: typeof send) => { send = value; },
  };
}

test("playback observation flush is single-flight and drains an ACK added during an in-flight request", async () => {
  const f = fixture();
  f.addObservation(f.observation("loading"));
  let release!: () => void;
  f.setSend(async () => { await new Promise<void>(resolve => { release = resolve; }); });
  const first = f.service.flushObservations();
  assert.equal(f.service.flushObservations(), first);
  f.addObservation(f.observation("playing", 2));
  f.setSend(async () => {});
  release();
  await first;
  assert.equal(f.sent.length, 2);
  assert.equal(f.observations.length, 0);
});

test("receipt network failure cannot block actual playback observations", async () => {
  const f = fixture();
  f.addReceipt();
  f.addObservation(f.observation());
  f.setSend(async (_scope, path) => { if (path === "receipts") throw new Error("network"); });
  await Promise.all([f.service.flushReceipts(), f.service.flushObservations()]);
  assert.equal(f.receipts.length, 1);
  assert.equal(f.observations.length, 0);
  f.setSend(async () => {});
  await f.service.flushReceipts();
  assert.equal(f.receipts.length, 0);
});

test("network failures retain ACKs while explicitly rejected stale ACKs are discarded", async () => {
  const f = fixture();
  f.addObservation(f.observation());
  f.setSend(async () => { throw new Error("network"); });
  await f.service.flushObservations();
  assert.equal(f.observations.length, 1);
  f.setSend(async () => { throw new Error("STALE_PLAYBACK_ACK"); });
  await f.service.flushObservations();
  assert.equal(f.observations.length, 0);
});

test("pending local actions fence receipt and observation synchronization until versions are reconciled", async () => {
  const f = fixture();
  f.addReceipt();
  f.addObservation(f.observation());
  f.setLocalPending(true);
  await Promise.all([f.service.flushReceipts(), f.service.flushObservations()]);
  assert.equal(f.sent.length, 0);
  f.setLocalPending(false);
  await Promise.all([f.service.flushReceipts(), f.service.flushObservations()]);
  assert.equal(f.sent.length, 2);
});

test("changing connection scope during a request never sends the next ACK to another session", async () => {
  const f = fixture();
  f.addObservation(f.observation("loading", 1));
  f.addObservation(f.observation("playing", 2));
  f.setSend(async () => { f.setScope({ backend: "/other", sessionId: "s2" }); });
  await f.service.flushObservations();
  assert.equal(f.sent.length, 1);
  assert.equal(f.observations.length, 1);
  assert.equal(f.sent[0].scope.sessionId, "s1");
});

test("offline and aborted connections keep durable observations untouched", async () => {
  const f = fixture();
  f.addObservation(f.observation());
  f.setScope(null);
  await f.service.flushObservations();
  const controller = new AbortController();
  controller.abort();
  f.setScope({ backend: "/api", sessionId: "s1", signal: controller.signal });
  await f.service.flushObservations();
  assert.equal(f.sent.length, 0);
  assert.equal(f.observations.length, 1);
});
