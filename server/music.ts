import { z } from "zod";
import type { Track } from "../src/protocol.js";
import { Fault } from "./store.js";

export type Resource = {
  availability: NonNullable<Track["availability"]>;
  url?: string;
  reason: string;
  expiresAt: number;
  playableDurationMs?: number;
};
export interface Music {
  search(query: string, limit: number, signal: AbortSignal): Promise<Track[]>;
  inspect(track: Track, signal: AbortSignal): Promise<Resource>;
}

const song = z.object({
  id: z.number(), name: z.string(), dt: z.number().optional(), duration: z.number().optional(),
  ar: z.array(z.object({ name: z.string() })).optional(),
  artists: z.array(z.object({ name: z.string() })).optional(),
  al: z.object({ name: z.string().optional(), picUrl: z.string().optional() }).optional(),
  album: z.object({ name: z.string().optional(), picUrl: z.string().optional() }).optional(),
});
const searchResult = z.object({ result: z.object({ songs: z.array(song).optional() }).optional() });
const resourceResult = z.object({
  data: z.array(z.object({
    id: z.number(), url: z.string().nullish(), time: z.number().nullish(),
    code: z.number().optional(), fee: z.number().optional(),
    freeTrialInfo: z.unknown().optional(),
    freeTrialPrivilege: z.object({
      resConsumable: z.boolean().optional(), userConsumable: z.boolean().optional(),
    }).nullish(),
  })).optional(),
});

export class NeteaseMusic implements Music {
  private artworkCache = new Map<string, { url: string; expires: number }>();
  private artworkPending = new Map<string, Promise<string | null>>();
  constructor(private base: string, private cookie?: string) {}
  setCookie(cookie: string | undefined) { this.cookie = cookie; }

  artwork(trackId: string): Promise<string | null> {
    if (!/^netease:\d{1,20}$/.test(trackId)) return Promise.resolve(null);
    const cached = this.artworkCache.get(trackId);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.url);
    const pending = this.artworkPending.get(trackId);
    if (pending) return pending;
    const job = (async () => {
      const payload = z.object({ songs: z.array(song) }).parse(
        await this.read("/song/detail", { ids: trackId.slice(8) }, AbortSignal.timeout(8000)));
      const entry = payload.songs.find(item => String(item.id) === trackId.slice(8));
      const value = entry?.al?.picUrl ?? entry?.album?.picUrl;
      if (!value) return null;
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
      if (url.hostname.endsWith(".music.126.net")) url.protocol = "https:";
      if (this.artworkCache.size >= 500) this.artworkCache.delete(this.artworkCache.keys().next().value!);
      this.artworkCache.set(trackId, { url: url.href, expires: Date.now() + 24 * 60 * 60 * 1000 });
      return url.href;
    })().finally(() => this.artworkPending.delete(trackId));
    this.artworkPending.set(trackId, job);
    return job;
  }

  private async read(path: string, values: Record<string, string>, signal: AbortSignal) {
    const url = new URL(`${this.base.replace(/\/$/, "")}${path}`);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, ...(this.cookie ? { cookie: this.cookie } : {}), crypto: "eapi", timeout: 7000 }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
    } catch {
      signal.throwIfAborted();
      throw new Fault("MUSIC_NETWORK_OR_TIMEOUT", 502);
    }
    if (!response.ok) throw new Fault(
      response.status === 429 ? "MUSIC_RATE_LIMITED" :
        [401, 403].includes(response.status) ? "MUSIC_AUTH_OR_ACCESS_DENIED" : "MUSIC_PROVIDER_UNAVAILABLE", 502);
    const payload = await response.json();
    if (payload && typeof payload === "object" && "code" in payload && Number(payload.code) !== 200) {
      throw new Fault(Number(payload.code) === 301 ? "MUSIC_LOGIN_REQUIRED" : "MUSIC_UPSTREAM_REJECTED", 502);
    }
    return payload;
  }

  async search(query: string, limit: number, signal: AbortSignal) {
    const payload = searchResult.parse(await this.read("/search", {
      keywords: query, limit: String(limit),
    }, signal));
    return (payload.result?.songs ?? []).map((item): Track => ({
      id: `netease:${item.id}`, title: item.name,
      artist: (item.ar ?? item.artists ?? []).map((a) => a.name).join(", ") || "Unknown",
      album: item.al?.name ?? item.album?.name,
      artworkUrl: item.al?.picUrl ?? item.album?.picUrl,
      durationMs: item.dt ?? item.duration,
      availability: "unknown",
    }));
  }

  async inspect(track: Track, signal: AbortSignal): Promise<Resource> {
    const id = track.id.replace(/^netease:/, "");
    let payload: z.infer<typeof resourceResult> | undefined;
    try {
      payload = resourceResult.parse(await this.read("/song/url/v1", { id, level: "standard" }, signal));
    } catch {
      signal.throwIfAborted();
    }
    if (!payload?.data?.some((item) => item.id === Number(id) && item.url)) {
      payload = resourceResult.parse(await this.read("/song/url", { id, br: "128000" }, signal));
    }
    const item = payload.data?.find((entry) => entry.id === Number(id));
    const expiresAt = Date.now() + 120_000;
    if (!item?.url) return { availability: "unknown", reason: "NO_RESOURCE_REASON_UNKNOWN", expiresAt };
    const shortened = track.durationMs && item.time && item.time > 0 &&
      item.time + 15_000 < track.durationMs && item.time < track.durationMs * 0.9;
    const parsed = new URL(item.url);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      return { availability: "unknown", reason: "INVALID_RESOURCE_URL", expiresAt };
    }
    if (item.freeTrialInfo || shortened ||
      item.freeTrialPrivilege?.resConsumable || item.freeTrialPrivilege?.userConsumable) {
      return { availability: "preview_only", url: parsed.href,
        ...(item.time && item.time > 0 ? { playableDurationMs: item.time } : {}),
        reason: "TRIAL_OR_SHORT_RESOURCE", expiresAt };
    }
    return {
      availability: "unknown", url: parsed.href, expiresAt,
      reason: "RESOURCE_RESOLVED_BROWSER_ACK_REQUIRED",
    };
  }
}
