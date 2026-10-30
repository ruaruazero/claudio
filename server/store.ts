import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { EventSchema, SettingsSchema, emptyRadio, type AgentEvent, type Snapshot, type Track, type PlaybackAck, type SpeechAck, type ServiceIssue } from "../src/protocol.js";
import type { Resource } from "./music.js";
import { persistCommandTransition } from "./playback-journal.js";

export type Candidate = { id: string; requestId: string; track: Track; resource?: Resource };
export type Command = {
  commandId: string; playbackVersion: number; action: "play" | "pause" | "stop";
  expiresAt: string; url?: string; track?: Track;
  resume?: boolean;
};
export type CommandProgress = {
  commandId: string;
  phase: "accepted" | "received" | "executing" | "succeeded" | "failed" | "blocked" | "ended";
  updatedAt: string;
};
export type RunRecord = {
  requestId: string; clientMessageId: string; text: string;
  status: "running" | "completed" | "partial" | "cancelled" | "failed";
  actions?: {
    operationId: string; commandId?: string; kind: "queue" | "playback";
    action?: "play" | "pause" | "stop";
    trackTitle?: string; queueVersion: number; playbackVersion: number;
  }[];
  replySource?: "model" | "fallback";
  failureCode?: string;
};
export type State = Snapshot & {
  controlEpoch: number;
  selectionEpoch: number;
  playerManaged: boolean;
  desiredPlayback: "play" | "pause" | "stop";
  backgroundRequestId: string | null;
  maintenance: {
    nextRefillAt: number; refillFailures: number; lastInputAt: number;
    endedCount: number; lastSpokenEnd: number; lastSpokenAt: number; lastSpeechAttemptAt: number;
    pendingEnd: { commandId: string; playbackVersion: number; attempts: number; retryAt: number } | null;
  };
  threadGeneration: number;
  rebuildThread: boolean;
  candidates: Candidate[];
  runs: RunRecord[];
  operations: Record<string, unknown>;
  command: Command | null;
  playbackAck: PlaybackAck | null;
  commandProgress: CommandProgress | null;
  playbackObservation: { track: Track | null; ack: PlaybackAck; observedAt: string } | null;
  speechAck: SpeechAck | null;
};
type NewEvent = { type: AgentEvent["type"]; payload: unknown; requestId?: string };

export class Store {
  db: Database.Database;
  private listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lab_sessions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lab_events(
        session_id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS lab_service_issues(service TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lab_archive(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,at TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lab_memory_evidence(source_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lab_playback_commands(
        session_id TEXT NOT NULL, command_id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(session_id, command_id)
      );
      CREATE TABLE IF NOT EXISTS lab_operation_inputs(
        session_id TEXT NOT NULL, operation_id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(session_id, operation_id)
      );
    `);
  }

  read(id: string): State {
    const row = this.db.prepare("SELECT body FROM lab_sessions WHERE id = ?").get(id) as { body: string } | undefined;
    if (!row) throw new Fault("SESSION_NOT_FOUND", 404);
    const state = JSON.parse(row.body);
    state.settings = SettingsSchema.parse(state.settings);
    state.controlEpoch ??= 0;
    state.selectionEpoch ??= 0;
    state.playerManaged ??= false;
    state.prepared ??= [];
    state.speechAck ??= null;
    state.commandProgress ??= null;
    state.playbackObservation ??= null;
    state.desiredPlayback ??= "play";
    state.backgroundRequestId ??= null;
    state.maintenance = { nextRefillAt: 0, refillFailures: 0, lastInputAt: 0,
      endedCount: 0, lastSpokenEnd: 0, lastSpokenAt: 0, lastSpeechAttemptAt: 0,
      pendingEnd: null, ...state.maintenance };
    return state;
  }

  create(id: string) {
    const state: State = {
      sessionId: id, messages: [], radio: structuredClone(emptyRadio),
      settings: { autoSpeech: false, proactive: true, allowPreview: true },
      controlEpoch: 0, selectionEpoch: 0, playerManaged: false, prepared: [], desiredPlayback: "play", backgroundRequestId: null,
      maintenance: { nextRefillAt: 0, refillFailures: 0, lastInputAt: 0,
        endedCount: 0, lastSpokenEnd: 0, lastSpokenAt: 0, lastSpeechAttemptAt: 0, pendingEnd: null },
      lastSequence: 0, activeRequestId: null, candidates: [], serviceIssues: [],
      threadGeneration: 0, rebuildThread: false,
      runs: [], operations: {}, command: null, playbackAck: null, speechAck: null,
      commandProgress: null, playbackObservation: null,
    };
    this.db.prepare("INSERT OR IGNORE INTO lab_sessions(id, body) VALUES (?, ?)").run(id, JSON.stringify(state));
    return this.snapshot(this.read(id));
  }

  snapshot(state: State): Snapshot {
    const { sessionId, messages, radio, settings, lastSequence, activeRequestId } = state;
    return { sessionId, messages, radio, settings, lastSequence, activeRequestId, desiredPlayback: state.desiredPlayback, prepared: [],
      serviceIssues: this.serviceIssues() };
  }

  serviceIssues(): ServiceIssue[] {
    return (this.db.prepare("SELECT body FROM lab_service_issues ORDER BY service").all() as { body: string }[])
      .map((row) => JSON.parse(row.body));
  }
  updateServiceIssue(sessionId: string, service: ServiceIssue["service"], issue: ServiceIssue | null) {
    const previous = this.serviceIssues().find((item) => item.service === service);
    if ((!previous && !issue) || (previous?.code === issue?.code && previous?.message === issue?.message)) return;
    if (issue) this.db.prepare("INSERT OR REPLACE INTO lab_service_issues(service,body) VALUES (?,?)")
      .run(service, JSON.stringify(issue));
    else this.db.prepare("DELETE FROM lab_service_issues WHERE service=?").run(service);
    for (const id of new Set([sessionId, ...this.listeners.keys()])) {
      this.change(id, (_, emit) => emit({ type: "service.updated", payload: { service, issue } }));
    }
  }

  change<T>(id: string, update: (state: State, emit: (event: NewEvent) => void) => T): T {
    const outgoing: AgentEvent[] = [];
    const result = this.db.transaction(() => {
      const state = this.read(id);
      const previousPlayback = structuredClone({
        command: state.command, playbackAck: state.playbackAck, commandProgress: state.commandProgress,
      });
      const value = update(state, (event) => {
        const parsed = EventSchema.parse({
          ...event, id: randomUUID(), sequence: state.lastSequence + 1,
          sessionId: id, at: new Date().toISOString(),
        });
        state.lastSequence = parsed.sequence;
        outgoing.push(parsed);
      });
      this.db.prepare("UPDATE lab_sessions SET body = ? WHERE id = ?").run(JSON.stringify(state), id);
      persistCommandTransition(this.db, id, previousPlayback, state);
      const insert = this.db.prepare("INSERT INTO lab_events(session_id, sequence, body) VALUES (?, ?, ?)");
      for (const event of outgoing) {
        insert.run(id, event.sequence, JSON.stringify(event));
        if (event.type === "message.saved" || event.type === "reply.final") {
          this.db.prepare("INSERT OR IGNORE INTO lab_archive VALUES (?,?,?,?)")
            .run(event.payload.id, id, event.payload.createdAt, JSON.stringify(event.payload));
          if (event.type === "message.saved" && event.payload.role === "user") {
            const confirmed = state.playbackAck && state.playbackAck.commandId === state.command?.commandId &&
              state.playbackAck.playbackVersion === state.radio.playbackVersion &&
              (!state.playbackAck.trackId || state.playbackAck.trackId === state.radio.current?.id);
            this.db.prepare("INSERT OR IGNORE INTO lab_memory_evidence VALUES (?,?)").run(event.payload.id,
              JSON.stringify({ track: confirmed ? state.command?.track ?? state.radio.current :
                state.playbackObservation?.track ?? state.radio.current,
                playbackStatus: confirmed ? state.playbackAck!.status : state.playbackObservation?.ack.status ?? "unknown",
                at: event.payload.createdAt }));
          }
        }
      }
      return value;
    })();
    for (const event of outgoing) {
      for (const listener of this.listeners.get(id) ?? []) {
        try { listener(event); }
        catch { console.warn("Claudio event delivery deferred; committed state is preserved."); }
      }
    }
    return result;
  }

  replay(id: string, after: number): AgentEvent[] {
    return (this.db.prepare("SELECT body FROM lab_events WHERE session_id = ? AND sequence > ? ORDER BY sequence")
      .all(id, after) as { body: string }[]).map((row) => JSON.parse(row.body));
  }

  subscribe(id: string, listener: (event: AgentEvent) => void) {
    const set = this.listeners.get(id) ?? new Set();
    set.add(listener);
    this.listeners.set(id, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(id);
    };
  }

  bindOperation(sessionId: string, operationId: string, kind: string, input: unknown, commit = true) {
    const body = JSON.stringify({ kind, input });
    const row = this.db.prepare("SELECT body FROM lab_operation_inputs WHERE session_id=? AND operation_id=?")
      .get(sessionId, operationId) as { body: string } | undefined;
    if (row && row.body !== body) throw new Fault("IDEMPOTENCY_CONFLICT");
    if (commit && !row) this.db.prepare("INSERT INTO lab_operation_inputs VALUES (?,?,?)")
      .run(sessionId, operationId, body);
  }

  recover() {
    const rows = this.db.prepare("SELECT id FROM lab_sessions").all() as { id: string }[];
    for (const { id } of rows) {
      this.change(id, (state, emit) => {
        if (state.activeRequestId) {
          const requestId = state.activeRequestId;
          const run = state.runs.find((r) => r.requestId === requestId);
          if (run) run.status = "failed";
          state.activeRequestId = null;
          state.threadGeneration++;
          state.rebuildThread = true;
          emit({ type: "run.failed", requestId, payload: { message: "运行被服务重启中断；已保存的对话与队列仍在。请发送新请求。" } });
        }
        state.command = null;
        state.playerManaged = false;
        state.playbackAck = null;
        state.commandProgress = null;
        state.playbackObservation = null;
        state.speechAck = null;
        state.backgroundRequestId = null;
        state.maintenance.pendingEnd = null;
      });
    }
  }
}

export class Fault extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
