import { z } from "zod";

const httpUrl = z.string().url().refine((s) => {
  try {
    const url = new URL(s);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
});
export const SettingsSchema = z.object({
  autoSpeech: z.boolean(),
  proactive: z.boolean(),
  allowPreview: z.boolean().default(true),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const TrackSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  album: z.string().optional(),
  artworkUrl: httpUrl.optional(),
  durationMs: z.number().nonnegative().optional(),
  availability: z.enum(["full", "preview_only", "requires_subscription", "unknown"]).optional(),
  playableDurationMs: z.number().positive().optional(),
});
export type Track = z.infer<typeof TrackSchema>;
export const PreparedTrackSchema = z.object({
  trackId: z.string(), url: httpUrl, expiresAt: z.number(),
  availability: TrackSchema.shape.availability,
  playableDurationMs: z.number().positive().optional(),
});
export type PreparedTrack = z.infer<typeof PreparedTrackSchema>;
export const LocalPlaybackSchema = z.object({
  commandId: z.string().min(1).max(100), action: z.enum(["play", "pause", "stop", "next", "select"]),
  expectedPlaybackVersion: z.number().int().nonnegative(),
  trackId: z.string().optional(),
  messageId: z.string().optional(),
  reason: z.enum(["user", "ended"]).optional(),
});
export type LocalPlayback = z.infer<typeof LocalPlaybackSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  clientMessageId: z.string().optional(),
  requestId: z.string().optional(),
  role: z.enum(["user", "assistant"]),
  source: z.enum(["model", "system"]).optional(),
  text: z.string(),
  createdAt: z.string(),
  status: z.enum(["pending", "saved", "failed", "complete"]),
  proactive: z.boolean().optional(),
  tracks: z.array(TrackSchema).max(6).optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const RadioSchema = z.object({
  queueVersion: z.number().int().nonnegative(),
  playbackVersion: z.number().int().nonnegative(),
  current: TrackSchema.nullable(),
  queue: z.array(TrackSchema),
});
export type Radio = z.infer<typeof RadioSchema>;

export const HealthSchema = z.object({
  service: z.literal("claudio-agent"),
  protocolVersion: z.literal(1),
  model: z.string().nullable(),
  modelConfigured: z.boolean().optional(),
  musicProvider: z.enum(["mock", "netease"]).optional(),
  capabilities: z.object({ autoSpeech: z.boolean(), proactive: z.boolean() }).optional(),
});
export const ServiceIssueSchema = z.object({
  service: z.enum(["model", "speech"]), code: z.string(), message: z.string(),
  at: z.string().datetime(),
});
export type ServiceIssue = z.infer<typeof ServiceIssueSchema>;
export const SessionSchema = z.object({
  sessionId: z.string().min(1),
  messages: z.array(MessageSchema),
  radio: RadioSchema,
  settings: SettingsSchema,
  lastSequence: z.number().int().nonnegative(),
  activeRequestId: z.string().nullable(),
  desiredPlayback: z.enum(["play", "pause", "stop"]).optional(),
  prepared: z.array(PreparedTrackSchema).default([]),
  serviceIssues: z.array(ServiceIssueSchema).default([]),
});
export type Snapshot = z.infer<typeof SessionSchema>;

const base = {
  id: z.string(),
  sequence: z.number().int().positive(),
  sessionId: z.string(),
  requestId: z.string().optional(),
  at: z.string(),
};
export const PlaybackAckSchema = z.object({
  commandId: z.string().min(1).max(100),
  playbackVersion: z.number().int().nonnegative(),
  ackSequence: z.number().int().nonnegative().default(0),
  trackId: z.string().optional(),
  status: z.enum(["loading", "playing", "paused", "ended", "failed", "blocked"]),
  positionMs: z.number().int().nonnegative(),
  message: z.string().max(300).optional(),
});
export type PlaybackAck = z.infer<typeof PlaybackAckSchema>;
export const PlaybackReceiptSchema = z.object({
  commandId: z.string().min(1).max(100),
  playbackVersion: z.number().int().nonnegative(),
  phase: z.enum(["received", "executing"]),
});
export type PlaybackReceipt = z.infer<typeof PlaybackReceiptSchema>;
export const PlayerAttachmentSchema = z.object({
  accepted: z.literal(true),
  reconciled: z.object({
    commandId: z.string(), playbackVersion: z.number().int().nonnegative(),
    ackSequence: z.number().int().nonnegative(), trackId: z.string().optional(),
  }).nullable(),
});
export const SpeechAckSchema = z.object({
  speechId: z.string().uuid(), sequence: z.number().int().nonnegative(),
  status: z.enum(["playing", "ended", "stopped", "failed", "blocked"]),
});
export type SpeechAck = z.infer<typeof SpeechAckSchema>;
const ModelAttemptSchema = z.object({
  callId: z.string().uuid(), attempt: z.number().int().min(1).max(2),
  phase: z.enum(["started", "completed", "retrying", "failed"]),
  durationMs: z.number().nonnegative().optional(), code: z.string().optional(),
  networkPhase: z.enum(["dns", "connect", "tls", "connection", "headers", "body", "request", "http", "unknown"]).optional(),
  networkCode: z.string().optional(), status: z.number().int().optional(),
  retryInMs: z.number().nonnegative().optional(),
});
export type ModelAttempt = z.infer<typeof ModelAttemptSchema>;

export const EventSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("service.updated"), payload: z.object({
    service: z.enum(["model", "speech"]), issue: ServiceIssueSchema.nullable(),
  }) }),
  z.object({ ...base, type: z.literal("model.attempt"), payload: ModelAttemptSchema }),
  z.object({ ...base, type: z.literal("context.updated"), payload: z.object({
    mode: z.enum(["background", "foreground"]),
    phase: z.enum(["started", "waiting", "completed", "deferred", "failed"]),
    code: z.string().optional(), causeCode: z.string().optional(),
  }) }),
  z.object({ ...base, type: z.literal("model.context"), payload: z.object({
    currentTrack: TrackSchema.nullable(), playingTrack: TrackSchema.nullable(),
    playbackStatus: z.enum(["loading", "playing", "paused", "ended", "failed", "blocked", "unknown", "unconfirmed"]),
    playbackVersion: z.number().int().nonnegative(), queueVersion: z.number().int().nonnegative(),
    currentTimeUtc: z.string().datetime(), timeZone: z.string(),
  }) }),
  z.object({ ...base, type: z.literal("speech.observed"), payload: SpeechAckSchema }),
  z.object({ ...base, type: z.literal("speech.synthesizing"),
    payload: z.object({ speechId: z.string(), messageId: z.string(), manual: z.boolean().optional() }) }),
  z.object({ ...base, type: z.literal("speech.completed"), payload: z.object({
    speechId: z.string(), messageId: z.string(), durationMs: z.number(), bytes: z.number(), chunks: z.number(),
  }) }),
  z.object({ ...base, type: z.literal("playback.observed"), payload: PlaybackAckSchema }),
  z.object({ ...base, type: z.literal("playback.received"), payload: PlaybackReceiptSchema }),
  z.object({ ...base, type: z.literal("message.saved"), payload: MessageSchema }),
  z.object({ ...base, type: z.literal("reply.final"), payload: MessageSchema }),
  z.object({
    ...base,
    type: z.literal("agent.activity"),
    payload: z.object({
      tool: z.string(),
      phase: z.enum(["started", "completed", "failed"]),
      summary: z.string().optional(),
      durationMs: z.number().nonnegative().optional(),
      code: z.string().optional(),
    }),
  }),
  z.object({ ...base, type: z.literal("queue.updated"), payload: RadioSchema }),
  z.object({ ...base, type: z.literal("resources.ready"), payload: z.array(PreparedTrackSchema) }),
  z.object({ ...base, type: z.literal("maintenance.updated"), payload: z.object({
    task: z.literal("refill"), status: z.enum(["started", "completed", "deferred", "cancelled"]),
    code: z.string().optional(), added: z.number().optional(), retryAt: z.number().optional(),
  }) }),
  z.object({
    ...base,
    type: z.literal("playback.command"),
    payload: z.object({
      commandId: z.string(),
      action: z.enum(["play", "pause", "stop"]),
      resume: z.boolean().optional(),
      playbackVersion: z.number().int().nonnegative(),
      expiresAt: z.string().datetime(),
      url: httpUrl.optional(),
      track: TrackSchema.optional(),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("speech.ready"),
    payload: z.object({
      speechId: z.string(),
      url: z.union([httpUrl, z.string().regex(/^\/api\/lab\/speech\/[\w-]+$/)]),
      expiresAt: z.string().datetime(),
      messageId: z.string().optional(),
      manual: z.boolean().optional(),
      generation: z.number().optional(),
      format: z.enum(["wav", "pcm16"]).default("wav"),
      sampleRate: z.number().int().positive().optional(),
      firstAudioMs: z.number().nonnegative().optional(),
    }),
  }),
  z.object({
    ...base, type: z.literal("speech.failed"),
    payload: z.object({ messageId: z.string(), speechId: z.string().optional(), code: z.string() }),
  }),
  z.object({
    ...base,
    type: z.literal("speech.cancelled"),
    payload: z.object({ speechId: z.string().optional() }),
  }),
  z.object({
    ...base,
    type: z.literal("settings.updated"),
    payload: SettingsSchema,
  }),
  z.object({
    ...base,
    type: z.enum(["run.completed", "run.cancelled", "run.failed", "run.partial"]),
    payload: z.object({
      message: z.string().optional(),
      code: z.string().optional(),
      actionsCommitted: z.boolean().optional(),
      incident: z.object({
        level: z.enum(["recovered", "degraded", "action_required", "protected"]),
        visibility: z.enum(["silent", "inline", "banner", "blocking"]),
        recovery: z.enum(["none", "reconnect", "play", "retry", "configure", "verify"]),
        message: z.string(),
      }).optional(),
      replySource: z.enum(["model", "fallback"]).optional(),
      durationMs: z.number().nonnegative().optional(),
      inputTokens: z.number().nonnegative().optional(),
      outputTokens: z.number().nonnegative().optional(),
    }),
  }),
]);
export type AgentEvent = z.infer<typeof EventSchema>;
export type TraceEntry = {
  id: string;
  type: AgentEvent["type"];
  sequence: number;
  requestId?: string;
  at: string;
  payload: unknown;
};

export const emptyRadio: Radio = {
  queueVersion: 0, playbackVersion: 0, current: null, queue: [],
};

export function normalizeBase(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  const url = new URL(trimmed);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("请输入不含账户信息或查询参数的 HTTP 地址。");
  }
  return trimmed;
}
