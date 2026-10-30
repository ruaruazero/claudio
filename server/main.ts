import { config } from "dotenv";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { makeApp } from "./http.js";
import { NeteaseMusic } from "./music.js";
import { MockMusic } from "./mock-music.js";
import { startNeteaseService } from "./netease-service.js";
import { ServiceConfiguration } from "./service-config.js";

config({ path: resolve(".env"), override: false });
process.env.LANGSMITH_TRACING = "false";
process.env.LANGCHAIN_TRACING_V2 = "false";
const settings = z.object({
  CLAUDIO_LAB_PORT: z.coerce.number().int().min(1024).max(65535).default(8081),
  CLAUDIO_LAB_DATABASE: z.string().default(".data/agent-lab.sqlite"),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  NETEASE_API_BASE_URL: z.string().url().default("http://127.0.0.1:3000"),
  NETEASE_COOKIE: z.string().optional(),
  CLAUDIO_MUSIC_PROVIDER: z.enum(["mock", "netease"]).default("mock"),
  NETEASE_EMBEDDED: z.enum(["true", "false"]).default("true"),
  MIMO_API_KEY: z.string().optional(),
  MIMO_TTS_MODEL: z.string().default("mimo-v2.5-tts"),
  MIMO_TTS_VOICE: z.string().default("mimo_default"),
  CLAUDIO_CONTEXT_BUDGET: z.coerce.number().int().min(12000).max(100000).default(48000),
}).parse(process.env);
const databasePath = resolve(settings.CLAUDIO_LAB_DATABASE);
mkdirSync(dirname(databasePath), { recursive: true });
const services = new ServiceConfiguration(resolve(dirname(databasePath), "credentials"), {
  modelKey: settings.DEEPSEEK_API_KEY?.trim() || undefined, model: settings.DEEPSEEK_MODEL || "deepseek-flash",
  speechKey: settings.MIMO_API_KEY?.trim() || undefined, speechModel: settings.MIMO_TTS_MODEL,
  baseURL: settings.DEEPSEEK_BASE_URL, voice: settings.MIMO_TTS_VOICE,
});
const runtime = services.runtime();
const musicService = settings.CLAUDIO_MUSIC_PROVIDER === "netease" && settings.NETEASE_EMBEDDED === "true"
  ? await startNeteaseService(settings.NETEASE_API_BASE_URL) : null;
const { app } = makeApp({
  databasePath, model: runtime.model, modelName: runtime.modelName, services,
  learning: true, contextBudget: settings.CLAUDIO_CONTEXT_BUDGET, auxiliaryModel: runtime.auxiliaryModel,
  credentialDirectory: resolve(dirname(databasePath), "credentials"), musicCookie: settings.NETEASE_COOKIE,
  musicProvider: settings.CLAUDIO_MUSIC_PROVIDER,
  speech: runtime.speech,
  music: settings.CLAUDIO_MUSIC_PROVIDER === "mock"
    ? new MockMusic(`http://127.0.0.1:${settings.CLAUDIO_LAB_PORT}`)
    : new NeteaseMusic(settings.NETEASE_API_BASE_URL, settings.NETEASE_COOKIE),
});
await app.listen({ host: "127.0.0.1", port: settings.CLAUDIO_LAB_PORT });
console.log(`Claudio Agent Lab backend: http://127.0.0.1:${settings.CLAUDIO_LAB_PORT}/api/lab`);
console.log(`Music provider: ${settings.CLAUDIO_MUSIC_PROVIDER}`);
console.log(`MiMo TTS: ${runtime.speech ? "configured" : "waiting for API Key in settings"}`);
console.log(runtime.model ? "Real model configured. Requests use the configured provider." :
  "Model not configured. Add API Key in settings; no simulated replies.");
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void app.close().finally(() => musicService?.close()); });
}
