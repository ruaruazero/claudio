import { z } from "zod";
import { request } from "./api";
import {
  localPlaybackOperations, playbackObservations, playbackReceipts,
  removePlaybackObservation, removePlaybackReceipt,
} from "./storage";

export type SyncScope = { backend: string; sessionId: string; signal?: AbortSignal };
type Receipt = ReturnType<typeof playbackReceipts>[number];
type Observation = ReturnType<typeof playbackObservations>[number];
type Dependencies = {
  scope: () => SyncScope | null;
  hasLocal: (scope: SyncScope) => boolean;
  receipts: () => Receipt[];
  observations: () => Observation[];
  removeReceipt: (item: Receipt) => void;
  removeObservation: (item: Observation) => void;
  send: (scope: SyncScope, path: string, body: unknown) => Promise<unknown>;
  storageFailed: () => void;
};
const accepted = z.object({ accepted: z.literal(true) });
const matches = (scope: SyncScope, item: { backend: string; sessionId: string }) =>
  scope.backend === item.backend && scope.sessionId === item.sessionId;

export class PlaybackSync {
  private receiptsJob: Promise<void> | null = null;
  private observationsJob: Promise<void> | null = null;
  constructor(private dependencies: Dependencies) {}

  private current(scope: SyncScope) {
    const current = this.dependencies.scope();
    return current && matches(scope, current) && scope.signal === current.signal && !scope.signal?.aborted;
  }

  flushReceipts(): Promise<void> {
    if (this.receiptsJob) return this.receiptsJob;
    const job = this.flush(false).finally(() => { if (this.receiptsJob === job) this.receiptsJob = null; });
    this.receiptsJob = job;
    return job;
  }
  flushObservations(): Promise<void> {
    if (this.observationsJob) return this.observationsJob;
    const job = this.flush(true).finally(() => { if (this.observationsJob === job) this.observationsJob = null; });
    this.observationsJob = job;
    return job;
  }

  private async flush(observations: boolean) {
    const scope = this.dependencies.scope();
    if (!scope) return;
    try {
      while (this.current(scope) && !this.dependencies.hasLocal(scope)) {
        const item = (observations ? this.dependencies.observations() : this.dependencies.receipts())
          .find(value => matches(scope, value));
        if (!item) return;
        const remove = () => {
          if ("ack" in item) this.dependencies.removeObservation(item);
          else this.dependencies.removeReceipt(item);
        };
        try {
          await this.dependencies.send(scope, observations ? "acks" : "receipts", "ack" in item ? item.ack : item.receipt);
          remove();
        } catch (error) {
          const stale = error instanceof Error && (observations
            ? ["STALE_PLAYBACK_ACK", "ACK_TRACK_MISMATCH", "ACK_ACTION_MISMATCH", "INVALID_PLAYBACK_TRANSITION"]
            : ["STALE_PLAYBACK_ACK"]).includes(error.message);
          if (!stale) return; // Network failures stay in the durable outbox for reconnect/retry.
          remove();
        }
      }
    } catch { this.dependencies.storageFailed(); }
  }
}

export function browserPlaybackSync(scope: () => SyncScope | null, storageFailed: () => void) {
  return new PlaybackSync({
    scope, storageFailed,
    hasLocal: scope => localPlaybackOperations().some(item => matches(scope, item)),
    receipts: playbackReceipts, observations: playbackObservations,
    removeReceipt: removePlaybackReceipt, removeObservation: removePlaybackObservation,
    send: (scope, path, body) => request(scope.backend,
      `/sessions/${encodeURIComponent(scope.sessionId)}/playback/${path}`, accepted,
      { method: "POST", body, signal: scope.signal }),
  });
}
