import type Database from "better-sqlite3";
import type { Command, State } from "./store.js";
import type { PlaybackAck } from "../src/protocol.js";

export type CommandRecord = {
  command: Omit<Command, "url">;
  status: "accepted" | "received" | "executing" | "succeeded" | "failed" | "blocked" | "superseded" | "interrupted";
  completion: PlaybackAck | null;
  latestAck: PlaybackAck | null;
  createdAt: string;
  updatedAt: string;
};
export type PlaybackSnapshot = Pick<State, "command" | "playbackAck" | "commandProgress">;

export function readCommand(db: Database.Database, sessionId: string, commandId: string): CommandRecord | null {
  const row = db.prepare("SELECT body FROM lab_playback_commands WHERE session_id=? AND command_id=?")
    .get(sessionId, commandId) as { body: string } | undefined;
  return row ? JSON.parse(row.body) : null;
}

// Called inside the same transaction as session state and outgoing events.
export function persistCommandTransition(db: Database.Database, sessionId: string,
  before: PlaybackSnapshot, after: PlaybackSnapshot) {
  const persist = (view: PlaybackSnapshot) => {
    if (!view.command) return null;
    const { url: _url, ...command } = view.command;
    const now = new Date().toISOString();
    const record: CommandRecord = readCommand(db, sessionId, command.commandId) ?? {
      command, status: "accepted", completion: null, latestAck: null, createdAt: now, updatedAt: now,
    };
    record.command = command;
    const ack = view.playbackAck?.commandId === command.commandId ? view.playbackAck : null;
    if (ack) {
      record.latestAck = ack;
      if (ack.status !== "loading" && !record.completion &&
        !["superseded", "interrupted"].includes(record.status)) {
        record.completion = ack;
        record.status = ack.status === "failed" || ack.status === "blocked" ? ack.status : "succeeded";
      }
    }
    if (!record.completion && !["superseded", "interrupted"].includes(record.status)) {
      const phase = view.commandProgress?.commandId === command.commandId ? view.commandProgress.phase : "accepted";
      if (phase === "accepted" || phase === "received" || phase === "executing") record.status = phase;
    }
    record.updatedAt = now;
    db.prepare("INSERT OR REPLACE INTO lab_playback_commands VALUES (?,?,?)")
      .run(sessionId, command.commandId, JSON.stringify(record));
    return record;
  };
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const previous = persist(before);
  if (previous && before.command?.commandId !== after.command?.commandId && !previous.completion) {
    previous.status = after.command ? "superseded" : "interrupted";
    db.prepare("UPDATE lab_playback_commands SET body=? WHERE session_id=? AND command_id=?")
      .run(JSON.stringify(previous), sessionId, previous.command.commandId);
  }
  persist(after);
}
