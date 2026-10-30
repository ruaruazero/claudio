import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeApp } from "./http.js";
import { NeteaseMusic } from "./music.js";
import { startNeteaseService } from "./netease-service.js";
import { ServiceConfiguration } from "./service-config.js";
import type { CredentialCodec } from "./music-account.js";

export async function startDesktopBackend(directory: string, token: string, codec?: CredentialCodec) {
  process.env.LANGSMITH_TRACING = "false";
  process.env.LANGCHAIN_TRACING_V2 = "false";
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const credentials = join(directory, "credentials");
  const services = new ServiceConfiguration(credentials, {
    model: "deepseek-flash", speechModel: "mimo-v2.5-tts",
    baseURL: "https://api.deepseek.com", voice: "mimo_default",
  }, codec);
  const musicService = await startNeteaseService("http://127.0.0.1:0");
  try {
    const address = musicService.server.address();
    if (!address || typeof address === "string") throw new Error("Music service address unavailable");
    const runtime = services.runtime();
    const { app, account } = makeApp({
      databasePath: join(directory, "claudio.sqlite"),
      ...runtime, services, credentialDirectory: credentials, credentialCodec: codec,
      desktopToken: token, musicProvider: "netease", learning: true, contextBudget: 48000,
      music: new NeteaseMusic(`http://127.0.0.1:${address.port}`),
    });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
    } catch (error) { await app.close(); throw error; }
    const backend = app.server.address();
    if (!backend || typeof backend === "string") throw new Error("Backend address unavailable");
    return { url: `http://127.0.0.1:${backend.port}`,
      connectMusicSession: (cookie: string, signal?: AbortSignal) => {
        if (!account) throw new Error("Music account unavailable");
        return account.acceptSession(cookie, signal);
      },
      close: async () => { try { await app.close(); } finally { await musicService.close(); } } };
  } catch (error) { await musicService.close(); throw error; }
}
