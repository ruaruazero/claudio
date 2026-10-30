import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { LocalPlaybackSchema, PlaybackAckSchema, PlaybackReceiptSchema, SettingsSchema, SpeechAckSchema } from "../src/protocol.js";
import { Fault, Store } from "./store.js";
import { RadioAgent } from "./agent.js";
import type { Music } from "./music.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { registerMockAudio } from "./mock-music.js";
import { SpeechService, type SpeechProvider } from "./speech.js";
import { PlaybackResources } from "./playback-resources.js";
import { LocationSchema } from "./environment.js";
import { MusicAccount, MusicCredentials, type CredentialCodec } from "./music-account.js";
import { NeteaseMusic } from "./music.js";
import { ServiceConfiguration, ServiceUpdate } from "./service-config.js";
import { registerMusicAudio } from "./music-audio.js";

const id = z.string().min(1).max(100).regex(/^[\w-]+$/);
const path = z.object({ sessionId: id });
const accepted = { accepted: true };
export function makeApp(options: {
  databasePath: string; music: Music; model: BaseChatModel | null; modelName: string | null;
  musicProvider?: "mock" | "netease";
  ackTimeoutMs?: number;
  speech?: SpeechProvider | null;
  learning?: boolean;
  contextBudget?: number;
  auxiliaryModel?: BaseChatModel | null;
  credentialDirectory?: string;
  credentialCodec?: CredentialCodec;
  desktopToken?: string;
  musicCookie?: string;
  musicAccountApi?: ConstructorParameters<typeof MusicAccount>[3];
  services?: ServiceConfiguration;
}) {
  const store = new Store(options.databasePath);
  store.recover();
  const agent = new RadioAgent(store, options.music, options.model, options.modelName,
    options.musicProvider, options.ackTimeoutMs, Boolean(options.speech),
    { learning: options.learning, contextBudget: options.contextBudget, auxiliaryModel: options.auxiliaryModel });
  const knowledge = agent.knowledge;
  const commands = agent.commands;
  const radio = agent.radio;
  const account = options.music instanceof NeteaseMusic && options.credentialDirectory
    ? new MusicAccount(knowledge, options.music, new MusicCredentials(options.credentialDirectory, "netease-credential", options.credentialCodec), options.musicAccountApi, options.musicCookie) : null;
  const speech = new SpeechService(store, options.speech ?? null);
  const resources = new PlaybackResources(store, options.music, radio);
  const watch = (sessionId: string) => { speech.watch(sessionId); resources.watch(sessionId); };
  const snapshot = (sessionId: string) => {
    watch(sessionId);
    return { ...store.snapshot(store.read(sessionId)), prepared: resources.prepared(sessionId) };
  };
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  let configuring = false;
  let verifying = false;
  const requireAccount = () => {
    if (!account) throw new Fault("MUSIC_ACCOUNT_NOT_AVAILABLE", 503);
    return account;
  };
  if (options.musicProvider === "mock") registerMockAudio(app);
  registerMusicAudio(app);
  const streams = new Set<() => void>();
  const connected = new Map<string, number>();
  const maintaining = new Set<string>();
  const maintenanceTimer = setInterval(() => {
    if (!configuring) agent.maintainMemory();
    for (const sessionId of connected.keys()) {
      if (configuring) continue;
      if (maintaining.has(sessionId)) continue;
      maintaining.add(sessionId);
      void agent.maintain(sessionId).catch(() => {}).finally(() => maintaining.delete(sessionId));
      void resources.refresh(sessionId).catch(() => {});
    }
  }, 5000);
  maintenanceTimer.unref();
  app.addHook("onRequest", async (request, reply) => {
    if (options.desktopToken) {
      const received = Buffer.from(String(request.headers["x-claudio-token"] ?? ""));
      const expected = Buffer.from(options.desktopToken);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        throw new Fault("ORIGIN_NOT_ALLOWED", 403);
      }
    }
    if (request.url.startsWith("/api/lab/services")) {
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host ?? "")) throw new Fault("ORIGIN_NOT_ALLOWED", 403);
      reply.header("Cache-Control", "no-store");
    }
    const origin = request.headers.origin;
    if (origin) {
      if (!/^http:\/\/(127\.0\.0\.1|localhost):518\d$/.test(origin)) throw new Fault("ORIGIN_NOT_ALLOWED", 403);
      reply.header("Access-Control-Allow-Origin", origin).header("Vary", "Origin");
      reply.header("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID");
      reply.header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    }
    if (request.method === "OPTIONS") return reply.code(204).send();
  });
  app.setErrorHandler((error, _, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "INVALID_INPUT" });
    if (error instanceof Fault) return reply.code(error.status).send({ error: error.code });
    return reply.code(500).send({ error: "SERVER_ERROR" });
  });
  app.get("/api/lab/health", async () => ({
    service: "claudio-agent", protocolVersion: 1, model: agent.modelName,
    modelConfigured: Boolean(agent.model),
    musicProvider: options.musicProvider ?? "netease",
    capabilities: { autoSpeech: Boolean(speech.provider), proactive: Boolean(agent.model) },
  }));
  app.get("/api/lab/services", async (_, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!options.services) throw new Fault("SERVICE_CONFIG_UNAVAILABLE", 503);
    return options.services.status();
  });
  app.patch("/api/lab/services", async request => {
    const input = ServiceUpdate.parse(request.body);
    if (!options.services) throw new Fault("SERVICE_CONFIG_UNAVAILABLE", 503);
    if (configuring || verifying || agent.configuringBlocked) throw new Fault("CONFIG_BUSY", 409);
    configuring = true;
    try {
      const prepared = options.services.prepare(input);
      await knowledge.idle();
      prepared.commit();
      speech.cancelAll();
      speech.provider = prepared.runtime.speech;
      await agent.configure(prepared.runtime.model, prepared.runtime.modelName, prepared.runtime.auxiliaryModel, Boolean(prepared.runtime.speech));
      return options.services.status();
    } finally { configuring = false; }
  });
  app.post("/api/lab/services/verify", async request => {
    const { service } = z.object({ service: z.enum(["model", "speech"]) }).strict().parse(request.body);
    if (!options.services) throw new Fault("SERVICE_CONFIG_UNAVAILABLE", 503);
    if (verifying || configuring) throw new Fault("CONFIG_BUSY", 409);
    verifying = true;
    try {
      const result = await options.services.verify(service);
      const session = store.db.prepare("SELECT id FROM lab_sessions LIMIT 1").get() as { id: string } | undefined;
      if (session) store.updateServiceIssue(session.id, service, null);
      return result;
    }
    finally { verifying = false; }
  });
  app.get("/api/lab/personalization", async () => ({
    memories: knowledge.list(), location: knowledge.config("location", null),
    profile: knowledge.profile().filter(tag => tag.polarity === "like"),
    timezone: knowledge.config("timezone", "Asia/Shanghai"), listening: knowledge.listening().slice(0, 12),
    accountAvailable: Boolean(account),
  }));
  app.get("/api/lab/sessions/:sessionId/recommendations", async request =>
    ({ traces: agent.recommendation.traces(path.parse(request.params).sessionId) }));
  app.post("/api/lab/memories/:memoryId/forget", async (request) => {
    const { memoryId } = z.object({ memoryId: z.string().uuid() }).parse(request.params);
    knowledge.forget(memoryId);
    speech.cancelAll();
    return accepted;
  });
  app.patch("/api/lab/memories/:memoryId", async (request) => {
    const { memoryId } = z.object({ memoryId: z.string().uuid() }).parse(request.params);
    const result = knowledge.correct(memoryId, z.object({ text: z.string().trim().min(1).max(500) }).parse(request.body).text);
    speech.cancelAll();
    return result;
  });
  app.get("/api/lab/locations", async (request) => {
    const { city } = z.object({ city: z.string().trim().min(2).max(80) }).parse(request.query);
    return agent.environment.search(city);
  });
  app.patch("/api/lab/location", async (request) => {
    const location = LocationSchema.nullable().parse(request.body);
    agent.environment.setLocation(location);
    if (location) void agent.environment.current().catch(() => {});
    return accepted;
  });
  app.get("/api/lab/weather", async () => agent.environment.current());
  app.get("/api/lab/music/artwork", async request => {
    const { trackId } = z.object({ trackId: z.string().regex(/^netease:\d{1,20}$/) }).parse(request.query);
    return { artworkUrl: options.music instanceof NeteaseMusic ? await options.music.artwork(trackId) : null };
  });
  app.get("/api/lab/music/account", async () => requireAccount().status());
  app.post("/api/lab/music/login/qr", async () => requireAccount().qr());
  app.post("/api/lab/music/login/check", async (request) =>
    requireAccount().check(z.object({ key: z.string().min(1).max(200) }).parse(request.body).key));
  app.post("/api/lab/music/logout", async () => requireAccount().logout());
  app.get("/api/lab/music/playlists", async () => requireAccount().playlists());
  app.post("/api/lab/music/import/playlist", async (request) =>
    requireAccount().importPlaylist(z.object({ value: z.string().trim().min(1).max(500) }).parse(request.body).value));
  app.post("/api/lab/music/import/history", async () => requireAccount().importHistory());
  app.post("/api/lab/sessions", async (request) => {
    const sessionId = z.object({ clientSessionId: id }).parse(request.body).clientSessionId;
    store.create(sessionId);
    return snapshot(sessionId);
  });
  app.get("/api/lab/sessions/:sessionId", async (request) =>
    snapshot(path.parse(request.params).sessionId));
  app.post("/api/lab/sessions/:sessionId/opening", async (request) => {
    const { sessionId } = path.parse(request.params);
    watch(sessionId);
    const body = z.object({ requestId: id, startup: z.boolean().optional() }).parse(request.body);
    if (configuring) throw new Fault("CONFIG_BUSY", 409);
    return agent.opening(sessionId, body.requestId, body.startup);
  });
  app.post("/api/lab/sessions/:sessionId/feedback", async (request) => {
    const { sessionId } = path.parse(request.params);
    const state = store.read(sessionId);
    const { trackId, choice } = z.object({ trackId: z.string(), choice: z.enum(["like", "dislike", "clear"]) }).parse(request.body);
    if (state.radio.current?.id !== trackId) throw new Fault("FEEDBACK_TRACK_CHANGED");
    const track = state.radio.current;
    knowledge.feedback(track!, choice);
    return { accepted: true, choice };
  });
  app.post("/api/lab/sessions/:sessionId/player/attach", async (request) => {
    const { sessionId } = path.parse(request.params);
    watch(sessionId);
    const body = z.object({ observation: PlaybackAckSchema.optional() }).parse(request.body ?? {});
    const result = commands.attach(sessionId, body.observation);
    void resources.refresh(sessionId).catch(() => {});
    return result;
  });
  app.get("/api/lab/sessions/:sessionId/resources", async (request) => {
    const { sessionId } = path.parse(request.params);
    watch(sessionId);
    void resources.refresh(sessionId).catch(() => {});
    return resources.prepared(sessionId);
  });
  app.post("/api/lab/sessions/:sessionId/playback/local", async (request) => {
    const { sessionId } = path.parse(request.params);
    const body = LocalPlaybackSchema.parse(request.body);
    await resources.ensureLocal(sessionId, body);
    return resources.observeLocal(sessionId, body);
  });
  app.post("/api/lab/sessions/:sessionId/recommendations/prepare", async (request) => {
    const { sessionId } = path.parse(request.params);
    const { messageId, trackId } = z.object({ messageId: id, trackId: z.string().min(1).max(200) }).parse(request.body);
    return resources.prepareRecommendation(sessionId, messageId, trackId);
  });
  app.post("/api/lab/sessions/:sessionId/speech/stop", async (request) => {
    speech.cancel(path.parse(request.params).sessionId);
    return accepted;
  });
  app.post("/api/lab/sessions/:sessionId/speech/replay", async (request) => {
    const { sessionId } = path.parse(request.params);
    const { messageId } = z.object({ messageId: id }).parse(request.body);
    watch(sessionId);
    speech.replay(sessionId, messageId);
    return accepted;
  });
  app.get("/api/lab/speech/:speechId", async (request, reply) => {
    const asset = speech.open(z.object({ speechId: z.string().uuid() }).parse(request.params).speechId);
    return reply.header("Cache-Control", "no-store").header("X-Accel-Buffering", "no")
      .type(asset.contentType).send(asset.body);
  });
  app.post("/api/lab/sessions/:sessionId/speech/acks", async (request) => {
    speech.observe(path.parse(request.params).sessionId, SpeechAckSchema.parse(request.body));
    return accepted;
  });
  app.patch("/api/lab/sessions/:sessionId/settings", async (request) => {
    const { sessionId } = path.parse(request.params);
    const settings = SettingsSchema.parse(request.body);
    watch(sessionId);
    if (settings.autoSpeech && !speech.provider) throw new Fault("TTS_NOT_CONFIGURED: 请在设置中填写 MiMo API Key。");
    return store.change(sessionId, (state, emit) => {
      state.settings = settings;
      emit({ type: "settings.updated", payload: settings });
      return settings;
    });
  });
  app.post("/api/lab/sessions/:sessionId/activity", async (request) => {
    agent.noteActivity(path.parse(request.params).sessionId);
    return accepted;
  });
  app.post("/api/lab/sessions/:sessionId/messages", async (request) => {
    const { sessionId } = path.parse(request.params);
    watch(sessionId);
    const body = z.object({
      clientMessageId: id, requestId: id, text: z.string().trim().min(1).max(4000),
    }).parse(request.body);
    if (configuring) throw new Fault("CONFIG_BUSY", 409);
    return agent.submit(sessionId, body);
  });
  app.post("/api/lab/sessions/:sessionId/runs/:requestId/cancel", async (request) => {
    const params = path.extend({ requestId: id }).parse(request.params);
    agent.cancel(params.sessionId, params.requestId);
    return accepted;
  });
  app.post("/api/lab/sessions/:sessionId/playback/commands", async (request) => {
    const { sessionId } = path.parse(request.params);
    const body = z.object({
      action: z.enum(["play", "pause", "stop", "next"]), requestId: id,
      expectedPlaybackVersion: z.number().int().nonnegative(),
    }).parse(request.body);
    await radio.control(body, sessionId, `manual:${body.requestId}`);
    return accepted;
  });
  app.post("/api/lab/sessions/:sessionId/playback/receipts", async (request) => {
    const { sessionId } = path.parse(request.params);
    commands.receive(sessionId, PlaybackReceiptSchema.parse(request.body));
    return accepted;
  });
  app.post("/api/lab/sessions/:sessionId/playback/acks", async (request) => {
    const { sessionId } = path.parse(request.params);
    const body = PlaybackAckSchema.parse(request.body);
    const changed = commands.observe(sessionId, body);
    if (changed && body.status === "ended" && !configuring) void agent.maintain(sessionId).catch(() => {});
    return accepted;
  });
  app.get("/api/lab/sessions/:sessionId/events", async (request, reply) => {
    const { sessionId } = path.parse(request.params);
    watch(sessionId);
    const state = store.read(sessionId);
    const query = z.object({ after: z.coerce.number().int().nonnegative().default(0) }).parse(request.query);
    const header = request.headers["last-event-id"];
    const after = Math.max(query.after, header ? z.coerce.number().int().nonnegative().parse(header) : 0);
    if (after > state.lastSequence) throw new Fault("CURSOR_AHEAD");
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive",
      ...(request.headers.origin ? { "Access-Control-Allow-Origin": request.headers.origin, Vary: "Origin" } : {}),
    });
    reply.raw.flushHeaders();
    const write = (event: { sequence: number }) => {
      if (!reply.raw.destroyed) reply.raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // No await between replay and subscribe; both run on the same event loop.
    for (const event of store.replay(sessionId, after)) write(event);
    const unsubscribe = store.subscribe(sessionId, write);
    const timer = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": keepalive\n\n");
    }, 15_000);
    connected.set(sessionId, (connected.get(sessionId) ?? 0) + 1);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      const count = (connected.get(sessionId) ?? 1) - 1;
      if (count) connected.set(sessionId, count); else {
        connected.delete(sessionId);
        agent.noteActivity(sessionId);
      }
      clearInterval(timer); unsubscribe(); streams.delete(close); reply.raw.end();
    };
    streams.add(close);
    reply.raw.on("close", close);
  });
  app.addHook("preClose", async () => {
    clearInterval(maintenanceTimer);
    for (const close of [...streams]) close();
    await resources.close();
    await speech.close();
    while (maintaining.size) await new Promise((resolve) => setTimeout(resolve, 10));
    await agent.close();
  });
  app.addHook("onClose", async () => { store.db.close(); });
  return { app, agent, store, resources, speech, commands, radio, account };
}
