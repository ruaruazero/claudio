import { PlaybackAckSchema, PlaybackReceiptSchema, type PlaybackAck, type PlaybackReceipt, type Track } from "../src/protocol.js";
import { Fault, Store, type State, type Command } from "./store.js";
import { readCommand } from "./playback-journal.js";
import { randomUUID } from "node:crypto";

export class PlaybackCommands {
  private closing = new AbortController();
  constructor(private store: Store, private timeoutMs = 4000,
    private recordCompletion?: (track: Track | null, ack: PlaybackAck) => void) {}

  issue(state: State, emit: Parameters<Parameters<Store["change"]>[1]>[1],
    command: Command, requestId?: string, publish = true) {
    if (readCommand(this.store.db, state.sessionId, command.commandId)) throw new Fault("IDEMPOTENCY_CONFLICT");
    if (command.playbackVersion !== state.radio.playbackVersion + 1) throw new Fault("PLAYBACK_VERSION_CONFLICT");
    if (state.playbackAck && !state.playbackObservation) state.playbackObservation = {
      track: state.command?.track ?? null, ack: state.playbackAck, observedAt: new Date().toISOString(),
    };
    state.radio.playbackVersion = command.playbackVersion;
    state.command = command;
    state.playbackAck = null;
    state.commandProgress = { commandId: command.commandId, phase: "accepted", updatedAt: new Date().toISOString() };
    emit({ type: "queue.updated", requestId, payload: state.radio });
    if (publish) emit({ type: "playback.command", requestId, payload: command });
  }

  result(sessionId: string, commandId: string): Record<string, unknown> {
    const record = readCommand(this.store.db, sessionId, commandId);
    const state = this.store.read(sessionId);
    const current = state.command?.commandId === commandId;
    const ack = current && state.playbackAck && state.playbackAck.status !== "loading"
      ? state.playbackAck : record?.completion;
    if (ack && ack.status !== "loading") return {
      playbackOutcome: ack.status, playbackConfirmed: ack.status === "playing",
      observed: { status: ack.status, positionMs: ack.positionMs },
      commandStatus: record?.status,
    };
    if (record && ["superseded", "interrupted"].includes(record.status)) {
      return { playbackOutcome: record.status, playbackConfirmed: false, commandStatus: record.status };
    }
    if (!current) return { playbackOutcome: "superseded", playbackConfirmed: false };
    return { playbackOutcome: "pending", playbackConfirmed: false,
      commandStatus: record?.status ?? state.commandProgress?.phase ?? "accepted",
      handledBySystem: true, retryable: false };
  }

  async waitForResult(sessionId: string, result: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.closing.signal.throwIfAborted();
    const committed = result as Record<string, unknown>;
    if (typeof committed.commandId !== "string") return result;
    const commandId = committed.commandId;
    if (committed.reused) return { ...committed, ...this.result(sessionId, commandId) };
    const waitSignal = AbortSignal.any([this.closing.signal, ...(signal ? [signal] : [])]);
    const outcome = await new Promise<Record<string, unknown>>((resolve, reject) => {
      let unsubscribe = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (value?: Record<string, unknown>, error?: unknown) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        waitSignal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value!);
      };
      // Cancelling this wait never cancels or reissues an already committed command.
      const abort = () => finish(undefined, waitSignal.reason);
      const check = () => {
        if (waitSignal.aborted) { abort(); return; }
        const value = this.result(sessionId, commandId);
        if (value.playbackOutcome !== "pending") finish(value);
      };
      unsubscribe = this.store.subscribe(sessionId, check);
      waitSignal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => finish(this.result(sessionId, commandId)), this.timeoutMs);
      check();
    });
    return { ...committed, ...outcome };
  }

  private assertCurrent(state: State, input: PlaybackReceipt | PlaybackAck) {
    if (state.command?.commandId !== input.commandId || state.radio.playbackVersion !== input.playbackVersion) {
      throw new Fault("STALE_PLAYBACK_ACK");
    }
  }

  attach(sessionId: string, observation?: PlaybackAck) {
    const input = observation ? PlaybackAckSchema.parse(observation) : null;
    return this.store.change(sessionId, (state, emit) => {
      state.playerManaged = true;
      if (!input) return { accepted: true as const, reconciled: null };
      const record = readCommand(this.store.db, sessionId, input.commandId);
      if (state.command || !record || record.command.playbackVersion !== input.playbackVersion ||
        input.playbackVersion !== state.radio.playbackVersion || input.trackId !== state.radio.current?.id ||
        record.command.track?.id !== input.trackId || !["playing", "paused"].includes(input.status) ||
        (input.status === "playing" && record.command.action !== "play")) {
        return { accepted: true as const, reconciled: null };
      }
      // Adopt a still-running browser player after restart without replaying audio.
      // A fresh ID/version fences off delayed messages from the old process.
      const command = {
        ...record.command, commandId: randomUUID(), playbackVersion: state.radio.playbackVersion + 1,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      };
      const ack = { ...input, commandId: command.commandId, playbackVersion: command.playbackVersion, ackSequence: 1 };
      this.issue(state, emit, command, undefined, false);
      state.playbackAck = ack;
      state.playbackObservation = { track: state.radio.current, ack, observedAt: new Date().toISOString() };
      state.commandProgress = { commandId: command.commandId,
        phase: ack.status === "loading" ? "executing" : ack.status === "failed" || ack.status === "blocked" ? ack.status : "succeeded",
        updatedAt: new Date().toISOString() };
      state.desiredPlayback = ack.status === "playing" ? "play" : record.command.action === "stop" ? "stop" : "pause";
      state.controlEpoch++;
      emit({ type: "playback.observed", payload: ack });
      return { accepted: true as const, reconciled: {
        commandId: command.commandId, playbackVersion: command.playbackVersion,
        ackSequence: ack.ackSequence, ...(input.trackId ? { trackId: input.trackId } : {}),
      } };
    });
  }

  receive(sessionId: string, value: PlaybackReceipt) {
    const input = PlaybackReceiptSchema.parse(value);
    return this.store.change(sessionId, (state, emit) => {
      this.assertCurrent(state, input);
      if (state.playbackAck?.commandId === input.commandId && state.playbackAck.status !== "loading") return;
      const previous = state.commandProgress;
      if (previous?.commandId === input.commandId &&
        (previous.phase === input.phase || !["accepted", "received"].includes(previous.phase))) return;
      state.commandProgress = { commandId: input.commandId, phase: input.phase, updatedAt: new Date().toISOString() };
      emit({ type: "playback.received", payload: input });
    });
  }

  observe(sessionId: string, value: PlaybackAck): boolean {
    const input = PlaybackAckSchema.parse(value);
    return this.store.change(sessionId, (state, emit) => {
      this.assertCurrent(state, input);
      if (input.trackId && input.trackId !== state.command!.track?.id) throw new Fault("ACK_TRACK_MISMATCH");
      if (["loading", "playing", "ended", "blocked"].includes(input.status) && state.command!.action !== "play") {
        throw new Fault("ACK_ACTION_MISMATCH");
      }
      if (state.playbackAck && input.ackSequence <= state.playbackAck.ackSequence) return false;
      if (state.playbackAck && ["ended", "failed"].includes(state.playbackAck.status)) {
        if (input.status !== state.playbackAck.status) throw new Fault("INVALID_PLAYBACK_TRANSITION");
        return false;
      }
      if (input.status === "ended") {
        state.maintenance.endedCount++;
        if (!state.playerManaged) state.maintenance.pendingEnd = {
          commandId: input.commandId, playbackVersion: input.playbackVersion, attempts: 0, retryAt: Date.now(),
        };
        this.recordCompletion?.(state.command?.track ?? null, input);
      }
      state.playbackAck = input;
      state.playbackObservation = { track: state.command?.track ?? null, ack: input, observedAt: new Date().toISOString() };
      const record = readCommand(this.store.db, sessionId, input.commandId);
      const completed = record?.completion != null;
      state.commandProgress = { commandId: input.commandId,
        phase: completed ? record!.status === "succeeded" ? "succeeded" : record!.status === "blocked" ? "blocked" : "failed"
          : input.status === "loading" ? state.commandProgress?.phase === "succeeded" ? "succeeded" : "executing"
          : input.status === "playing" || input.status === "paused" ? "succeeded" : input.status,
        updatedAt: new Date().toISOString() };
      emit({ type: "playback.observed", payload: input });
      return true;
    });
  }

  close() { this.closing.abort(new Fault("SERVICE_CLOSING", 503)); }
}
