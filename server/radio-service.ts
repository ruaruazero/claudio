import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Fault, Store, type Command, type State } from "./store.js";
import type { Music } from "./music.js";
import type { Knowledge } from "./knowledge.js";
import { QUEUE_POLICY } from "../src/queue-policy.js";
import { assertWrite, candidateFor, resourceAllowed, queueInput, playbackInput, type RadioContext } from "./radio-contracts.js";
import type { PlaybackCommands } from "./playback-commands.js";
import { LocalPlaybackSchema, type LocalPlayback, type PreparedTrack } from "../src/protocol.js";
type Emitter = Parameters<Parameters<Store["change"]>[1]>[1];

export class RadioService {
  constructor(private store: Store, private music: Music, private knowledge: Knowledge,
    private commands: PlaybackCommands,
    private assertLive: (context: RadioContext, signal?: AbortSignal) => void,
    private speechConfigured: () => boolean = () => false) {}

  state(id: string) {
    const state = this.store.read(id);
    const ack = state.playbackAck;
    const confirmed = ack && ack.commandId === state.command?.commandId &&
      ack.playbackVersion === state.radio.playbackVersion &&
      (!ack.trackId || ack.trackId === state.radio.current?.id);
    const observation = confirmed ? { track: state.command?.track ?? state.radio.current, ack } : state.playbackObservation;
    const status = observation?.ack.status ?? "unknown";
    const progress = state.commandProgress?.commandId === state.command?.commandId ? state.commandProgress : null;
    const commandStatus = progress?.phase ?? (confirmed ? ack.status === "loading" ? "executing"
      : ack.status === "playing" || ack.status === "paused" ? "succeeded" : ack.status
      : state.command ? "accepted" : null);
    return { ...state.radio, playbackAck: state.playbackAck, allowPreview: state.settings.allowPreview,
      desiredPlayback: state.desiredPlayback, queuePolicy: QUEUE_POLICY,
      command: state.command ? { commandId: state.command.commandId, action: state.command.action,
        status: commandStatus, expiresAt: state.command.expiresAt } : null,
      playback: { status, playingTrack: status === "playing" ? observation?.track ?? null : null,
        lastReportedPositionMs: observation?.ack.positionMs ?? null },
      speech: { available: this.speechConfigured(), autoSpeech: state.settings.autoSpeech,
        trigger: "system_after_final_reply", playback: state.speechAck?.status ?? "unconfirmed",
        observation: state.speechAck } };
  }

  private emitCommand(state: State, emit: Emitter, action: Command["action"], resource?: string, requestId?: string, resume = false) {
    const command: Command = {
      commandId: randomUUID(), action, resume,
      playbackVersion: state.radio.playbackVersion + 1,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      ...(resource ? { url: resource } : {}),
      ...(state.radio.current ? { track: state.radio.current } : {}),
    };
    this.commands.issue(state, emit, command, requestId);
  }

  updateQueue(input: z.infer<typeof queueInput>, context: RadioContext, operationId: string, signal?: AbortSignal) {
    input = queueInput.parse(input);
    this.assertLive(context, signal);
    return this.store.change(context.sessionId, (state, emit) => {
      this.store.bindOperation(context.sessionId, operationId, "queue", input);
      if (Object.hasOwn(state.operations, operationId)) return state.operations[operationId];
      assertWrite(context, state);
      if (!context.background && state.radio.queueVersion !== input.expectedQueueVersion) throw new Fault("QUEUE_VERSION_CONFLICT");
      if (context.background && (input.mode !== "append" || input.timing !== "after_current")) throw new Fault("BACKGROUND_APPEND_ONLY");
      if (input.intent === "implicit_adaptation" && input.timing !== "after_current") throw new Fault("IMPLICIT_UPCOMING_ONLY");
      if (new Set(input.candidateIds).size !== input.candidateIds.length) throw new Fault("DUPLICATE_CANDIDATE");
      const candidates = input.candidateIds.map((id) => candidateFor(state, id, context));
      const feedback = this.knowledge.config<Record<string, string>>("trackFeedback", {});
      if ((context.background || input.intent === "implicit_adaptation") &&
        candidates.some((candidate) => feedback[candidate.track.id] === "dislike")) throw new Fault("EXPLICIT_DISLIKE");
      if (candidates.some((c) => !c.resource || !resourceAllowed(c.resource, state))) {
        throw new Fault("INSPECT_PLAYABLE_RESOURCES_FIRST");
      }
      let tracks = candidates.map((c) => ({ ...c.track, availability: c.resource!.availability,
        playableDurationMs: c.resource!.playableDurationMs }));
      const kept = input.mode === "replace" ? [] : state.radio.queue;
      if (context.background) {
        tracks = tracks.filter((track, index, all) => track.id !== state.radio.current?.id &&
          !kept.some((item) => item.id === track.id) && all.findIndex((item) => item.id === track.id) === index)
          .slice(0, Math.max(0, QUEUE_POLICY.targetCount - kept.length));
        if (!tracks.length) {
          const result = { ok: true, added: 0, queueCommitted: false, playbackConfirmed: false };
          state.operations[operationId] = result;
          return result;
        }
      }
      if (kept.length + tracks.length > QUEUE_POLICY.maxCount) throw new Fault("QUEUE_CAPACITY");
      const immediate = input.mode === "replace" && input.timing === "now";
      const startsPlayback = !context.background && input.intent !== "implicit_adaptation" &&
        (immediate || (state.desiredPlayback === "play" && !state.radio.current));
      if (!context.background && input.mode !== "append") state.selectionEpoch++;
      if (input.mode === "replace") state.radio.queue = tracks;
      else if (input.mode === "insert_next") state.radio.queue.unshift(...tracks);
      else state.radio.queue.push(...tracks);
      state.radio.queueVersion++;
      if (startsPlayback) {
        state.desiredPlayback = "play";
        state.radio.current = state.radio.queue.shift() ?? null;
        const resource = candidates.find((c) => c.track.id === state.radio.current?.id)?.resource;
        if (!resource?.url) throw new Fault("NO_PLAYABLE_CURRENT");
        this.emitCommand(state, emit, "play", resource.url, context.requestId);
      } else emit({ type: "queue.updated", requestId: context.requestId, payload: state.radio });
      const result = { ok: true, added: tracks.length, status: "accepted", ...this.store.snapshot(state).radio,
        queueCommitted: true, playbackConfirmed: false,
        ...(startsPlayback && state.command ? { commandId: state.command.commandId } : {}) };
      state.operations[operationId] = result;
      this.recordAction(state, context, operationId, "queue", startsPlayback);
      return result;
    });
  }

  async control(input: z.infer<typeof playbackInput>, sessionId: string, operationId: string,
    signal: AbortSignal = new AbortController().signal, context?: RadioContext) {
    input = playbackInput.parse(input);
    signal.throwIfAborted();
    this.store.bindOperation(sessionId, operationId, "playback", input, false);
    if (context) this.assertLive(context, signal);
    let state = this.store.read(sessionId);
    if (context?.background) throw new Fault("BACKGROUND_CANNOT_CONTROL");
    if (context) assertWrite(context, state);
    if (Object.hasOwn(state.operations, operationId)) return state.operations[operationId];
    if (state.radio.playbackVersion !== input.expectedPlaybackVersion) throw new Fault("PLAYBACK_VERSION_CONFLICT");
    const existing = state.command;
    const existingAck = state.playbackAck?.commandId === existing?.commandId ? state.playbackAck : null;
    const issuedThisRun = context && state.runs.find(run => run.requestId === context.requestId)?.actions
      ?.some(action => action.commandId === existing?.commandId);
    if (input.action === "play" && state.desiredPlayback === "play" && existing?.action === "play" &&
      existing.track?.id === state.radio.current?.id &&
      (existingAck?.status === "playing" || ((!existingAck || existingAck.status === "loading") &&
        (issuedThisRun || Date.parse(existing.expiresAt) > Date.now())))) {
      const reused = { ok: true, status: "accepted", reused: true, commandId: existing.commandId,
        playbackVersion: state.radio.playbackVersion, ...this.commands.result(sessionId, existing.commandId) };
      return this.store.change(sessionId, latest => {
        this.store.bindOperation(sessionId, operationId, "playback", input);
        latest.operations[operationId] = reused;
        return reused;
      });
    }
    const target = input.action === "next" ? state.radio.queue[0] : state.radio.current;
    if (!target && ["play", "next"].includes(input.action)) throw new Fault("NO_TRACK");
    const inspectionSignal = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
    const inspect = async () => {
      // Also bound adapters that fail to settle promptly after cancellation.
      let abort!: () => void;
      try {
        return await Promise.race([
          this.music.inspect(target!, inspectionSignal),
          new Promise<never>((_, reject) => {
            abort = () => reject(new Fault(signal.aborted ? "CONTROL_CANCELLED" : "MUSIC_RESOURCE_TIMEOUT", 504));
            inspectionSignal.addEventListener("abort", abort, { once: true });
            if (inspectionSignal.aborted) abort();
          }),
        ]);
      } finally { inspectionSignal.removeEventListener("abort", abort); }
    };
    const resource = ["play", "next"].includes(input.action) ? await inspect() : undefined;
    inspectionSignal.throwIfAborted();
    signal.throwIfAborted();
    if (context) this.assertLive(context, signal);
    return this.store.change(sessionId, (latest, emit) => {
      this.store.bindOperation(sessionId, operationId, "playback", input);
      if (Object.hasOwn(latest.operations, operationId)) return latest.operations[operationId];
      if (context) assertWrite(context, latest);
      if (resource && !resourceAllowed(resource, latest)) throw new Fault("RESOURCE_UNAVAILABLE");
      if (latest.radio.playbackVersion !== input.expectedPlaybackVersion ||
        latest.radio.queueVersion !== state.radio.queueVersion ||
        (input.action === "next" ? latest.radio.queue[0]?.id : latest.radio.current?.id) !== target?.id) {
        throw new Fault("PLAYBACK_VERSION_CONFLICT");
      }
      if (input.action === "next") {
        latest.radio.current = latest.radio.queue.shift()!;
        latest.radio.queueVersion++;
      }
      if (resource && latest.radio.current) latest.radio.current = { ...latest.radio.current,
        availability: resource.availability, playableDurationMs: resource.playableDurationMs };
      latest.desiredPlayback = ["play", "next"].includes(input.action) ? "play" : input.action as "pause" | "stop";
      if (!context) {
        latest.controlEpoch++;
        latest.maintenance.pendingEnd = null;
      }
      this.emitCommand(latest, emit,
        ["play", "next"].includes(input.action) ? "play" : input.action as "pause" | "stop", resource?.url, context?.requestId,
        input.action === "play");
      const result = { ok: true, status: "requested", playbackVersion: latest.radio.playbackVersion,
        commandId: latest.command!.commandId };
      latest.operations[operationId] = result;
      if (context) this.recordAction(latest, context, operationId, "playback", true);
      return result;
    });
  }

  observeLocal(sessionId: string, input: LocalPlayback, prepared?: PreparedTrack) {
    input = LocalPlaybackSchema.parse(input);
    return this.store.change(sessionId, (state, emit) => {
      const key = `local:${input.commandId}`;
      this.store.bindOperation(sessionId, key, "local-playback", input);
      if (Object.hasOwn(state.operations, key)) return state.operations[key];
      if (state.radio.playbackVersion !== input.expectedPlaybackVersion) throw new Fault("PLAYBACK_VERSION_CONFLICT");
      const previousTrack = state.radio.current;
      const previousPosition = state.playbackAck?.positionMs ?? 0;
      const starts = input.action === "play" || input.action === "next" || input.action === "select";
      const track = input.action === "select" ? state.messages.find(message => message.id === input.messageId && message.role === "assistant")?.tracks?.find(track => track.id === input.trackId)
        : input.action === "next" ? state.radio.queue[0] : state.radio.current;
      if (starts && (!track || track.id !== input.trackId)) throw new Fault("LOCAL_TRACK_CONFLICT");
      const resource = starts && prepared && prepared.trackId === input.trackId &&
        prepared.expiresAt > Date.now() && prepared.availability !== "requires_subscription" &&
        (state.settings.allowPreview || prepared.availability !== "preview_only") ? prepared : undefined;
      if (starts && !resource) throw new Fault("RESOURCE_NOT_PREPARED");
      if (input.action === "next") {
        if (input.reason === "ended" && state.playbackAck?.status !== "ended") state.maintenance.endedCount++;
        state.radio.current = state.radio.queue.shift()!;
        state.radio.queueVersion++;
      }
      if (input.action === "select") state.radio.current = track!;
      if (resource && state.radio.current) state.radio.current = { ...state.radio.current,
        availability: resource.availability, playableDurationMs: resource.playableDurationMs };
      state.controlEpoch++;
      state.desiredPlayback = starts ? "play" : input.action as "pause" | "stop";
      state.maintenance.pendingEnd = null;
      this.commands.issue(state, emit, {
        commandId: input.commandId, playbackVersion: state.radio.playbackVersion + 1,
        action: starts ? "play" : input.action as "pause" | "stop",
        resume: input.action === "play",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        ...(track ? { track } : {}), ...(resource ? { url: resource.url } : {}),
      }, undefined, false);
      const accepted = { accepted: true as const, playbackVersion: state.radio.playbackVersion };
      state.operations[key] = accepted;
      this.knowledge.listen(`local:${input.commandId}`, previousTrack, input.action === "next"
        ? input.reason === "ended" ? "completed" : "skipped" : input.action, previousPosition, input.reason === "ended");
      return accepted;
    });
  }
  private recordAction(state: State, context: RadioContext, operationId: string,
    kind: "queue" | "playback", hasCommand: boolean) {
    const run = state.runs.find((item) => item.requestId === context.requestId);
    if (!run) return;
    (run.actions ??= []).push({
      operationId, kind, queueVersion: state.radio.queueVersion,
      playbackVersion: state.radio.playbackVersion,
      ...(hasCommand && state.command ? {
        commandId: state.command.commandId, action: state.command.action,
        trackTitle: state.command.track?.title,
      } : {}),
    });
  }

}
