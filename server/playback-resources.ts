import type { LocalPlayback, PreparedTrack, Track } from "../src/protocol.js";
import type { Music, Resource } from "./music.js";
import { Fault, Store } from "./store.js";
import type { RadioService } from "./radio-service.js";

function allowed(resource: Resource, allowPreview: boolean) {
  return Boolean(resource.url) && resource.expiresAt > Date.now() + 5000 &&
    resource.availability !== "requires_subscription" &&
    (allowPreview || resource.availability !== "preview_only");
}

export class PlaybackResources {
  private caches = new Map<string, Map<string, Resource>>();
  private jobs = new Map<string, Promise<void>>();
  private published = new Map<string, string>();
  private subscriptions = new Map<string, () => void>();
  private closing = new AbortController();
  constructor(private store: Store, private music: Music, private radio: RadioService) {}

  watch(sessionId: string) {
    if (this.subscriptions.has(sessionId) || this.closing.signal.aborted) return;
    this.subscriptions.set(sessionId, this.store.subscribe(sessionId, (event) => {
      if (event.type === "queue.updated" || event.type === "settings.updated") {
        queueMicrotask(() => { void this.refresh(sessionId).catch(() => {}); });
      }
    }));
  }
  prepared(sessionId: string): PreparedTrack[] {
    const state = this.store.read(sessionId);
    const cache = this.caches.get(sessionId);
    return [state.radio.current, ...state.radio.queue.slice(0, 3)].flatMap((track) => {
      if (!track) return [];
      const resource = cache?.get(track.id) ??
        [...state.candidates].reverse().find((item) => item.track.id === track.id && item.resource)?.resource;
      return resource && allowed(resource, state.settings.allowPreview) ? [{
        trackId: track.id, url: resource.url!, expiresAt: resource.expiresAt,
        availability: resource.availability, playableDurationMs: resource.playableDurationMs,
      }] : [];
    });
  }
  refresh(sessionId: string): Promise<void> {
    if (this.closing.signal.aborted) return Promise.resolve();
    const existing = this.jobs.get(sessionId);
    if (existing) return existing;
    const job = this.prepare(sessionId).finally(() => this.jobs.delete(sessionId));
    this.jobs.set(sessionId, job);
    return job;
  }
  recommendation(sessionId: string, messageId: string | undefined, trackId: string | undefined): Track {
    const track = this.store.read(sessionId).messages.find((m) =>
      m.id === messageId && m.role === "assistant")?.tracks?.find((t) => t.id === trackId);
    if (!track) throw new Fault("RECOMMENDATION_NOT_FOUND", 404);
    return track;
  }
  async prepareRecommendation(sessionId: string, messageId: string, trackId: string): Promise<PreparedTrack> {
    const track = this.recommendation(sessionId, messageId, trackId);
    return this.prepareTrack(sessionId, track);
  }
  private async prepareTrack(sessionId: string, track: Track): Promise<PreparedTrack> {
    const state = this.store.read(sessionId);
    const cache = this.caches.get(sessionId) ?? new Map<string, Resource>();
    this.caches.set(sessionId, cache);
    let resource = cache.get(track.id) ??
      [...state.candidates].reverse().find((c) => c.track.id === track.id && c.resource)?.resource;
    if (!resource || !allowed(resource, state.settings.allowPreview)) {
      resource = await this.music.inspect(track, AbortSignal.any([this.closing.signal, AbortSignal.timeout(6000)]));
    }
    if (!allowed(resource, this.store.read(sessionId).settings.allowPreview)) throw new Fault("RESOURCE_UNAVAILABLE");
    cache.set(track.id, resource);
    return { trackId: track.id, url: resource.url!, expiresAt: resource.expiresAt,
      availability: resource.availability, playableDurationMs: resource.playableDurationMs };
  }
  async ensureLocal(sessionId: string, input: LocalPlayback) {
    if (!["play", "next", "select"].includes(input.action)) return;
    const state = this.store.read(sessionId);
    this.store.bindOperation(sessionId, `local:${input.commandId}`, "local-playback", input, false);
    if (Object.hasOwn(state.operations, `local:${input.commandId}`)) return;
    if (state.radio.playbackVersion !== input.expectedPlaybackVersion) throw new Fault("PLAYBACK_VERSION_CONFLICT");
    const track = input.action === "select" ? this.recommendation(sessionId, input.messageId, input.trackId)
      : input.action === "next" ? state.radio.queue[0] : state.radio.current;
    if (!track || track.id !== input.trackId) throw new Fault("LOCAL_TRACK_CONFLICT");
    await this.prepareTrack(sessionId, track);
  }
  private async prepare(sessionId: string) {
    const state = this.store.read(sessionId);
    const tracks = [state.radio.current, ...state.radio.queue.slice(0, 3)].filter((track) => track !== null);
    const cache = this.caches.get(sessionId) ?? new Map<string, Resource>();
    this.caches.set(sessionId, cache);
    const retained = new Set([...tracks.map((track) => track.id),
      ...state.messages.slice(-30).flatMap((m) => m.tracks?.map((t) => t.id) ?? [])]);
    for (const id of cache.keys()) if (!retained.has(id)) cache.delete(id);
    await Promise.all(tracks.map(async (track) => {
      if (this.closing.signal.aborted) return;
      const known = cache.get(track.id) ??
        [...this.store.read(sessionId).candidates].reverse().find((item) => item.track.id === track.id && item.resource)?.resource;
      if (known && allowed(known, state.settings.allowPreview)) { cache.set(track.id, known); return; }
      try {
        const signal = AbortSignal.any([this.closing.signal, AbortSignal.timeout(6000)]);
        let aborted!: () => void;
        try {
          const resource = await Promise.race([this.music.inspect(track, signal),
            new Promise<never>((_, reject) => {
              aborted = () => reject(signal.reason);
              signal.addEventListener("abort", aborted, { once: true });
              if (signal.aborted) aborted();
            })]);
          signal.throwIfAborted();
          cache.set(track.id, resource);
        } finally { if (aborted) signal.removeEventListener("abort", aborted); }
      } catch { /* A missing resource must not block local pause or other prepared tracks. */ }
    }));
    if (this.closing.signal.aborted) return;
    const prepared = this.prepared(sessionId);
    const signature = JSON.stringify(prepared);
    if (this.published.get(sessionId) === signature) return;
    this.published.set(sessionId, signature);
    this.store.change(sessionId, (_, emit) => emit({ type: "resources.ready", payload: prepared }));
  }
  observeLocal(sessionId: string, input: LocalPlayback) {
    const cached = input.action === "select" && input.trackId ? this.caches.get(sessionId)?.get(input.trackId) : undefined;
    const prepared = cached && allowed(cached, this.store.read(sessionId).settings.allowPreview)
      ? { trackId: input.trackId!, url: cached.url!, expiresAt: cached.expiresAt,
        availability: cached.availability, playableDurationMs: cached.playableDurationMs }
      : this.prepared(sessionId).find(item => item.trackId === input.trackId);
    const result = this.radio.observeLocal(sessionId, input, prepared);
    void this.refresh(sessionId).catch(() => {});
    return result;
  }
  async close() {
    this.closing.abort();
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    await Promise.allSettled([...this.jobs.values()]);
    this.caches.clear();
  }
}
