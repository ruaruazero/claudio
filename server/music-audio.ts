import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Fault } from "./store.js";

export function musicCdnUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Fault("INVALID_AUDIO_URL", 400); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port ||
    !/(^|\.)music\.(126\.net|163\.com)$/.test(url.hostname)) throw new Fault("INVALID_AUDIO_URL", 400);
  return url;
}

export function registerMusicAudio(app: FastifyInstance, upstream: typeof fetch = fetch) {
  app.get("/api/lab/music/audio", async (request, reply) => {
    const { url: raw } = z.object({ url: z.string().max(4096) }).parse(request.query);
    let url = musicCdnUrl(raw);
    const controller = new AbortController();
    const disconnect = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.once("close", disconnect);
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const headers: Record<string, string> = {};
      if (request.headers.range) headers.Range = request.headers.range;
      let response: Response | undefined;
      for (let redirects = 0; redirects <= 3; redirects++) {
        response = await upstream(url, { signal: controller.signal, redirect: "manual", headers });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === 3) throw new Fault("AUDIO_UPSTREAM_UNAVAILABLE", 502);
        url = musicCdnUrl(new URL(location, url).href);
      }
      clearTimeout(timer);
      if (!response || ![200, 206, 416].includes(response.status)) {
        await response?.body?.cancel();
        throw new Fault("AUDIO_UPSTREAM_UNAVAILABLE", 502);
      }
      reply.code(response.status);
      for (const key of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const value = response.headers.get(key);
        if (value) reply.header(key, value);
      }
      reply.header("Cache-Control", "private, max-age=60");
      if (!response.body) return reply.send();
      // Stream through unchanged: preserve seeking and do not buffer an entire song.
      return reply.send(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream));
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault("AUDIO_UPSTREAM_UNAVAILABLE", 502);
    } finally { clearTimeout(timer); }
  });
}
