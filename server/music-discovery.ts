import { randomUUID } from "node:crypto";
import type { Music } from "./music.js";
import type { Knowledge } from "./knowledge.js";
import { Store } from "./store.js";
import { candidateFor, resourceAllowed, type RadioContext } from "./radio-contracts.js";
import type { Track } from "../src/protocol.js";

export class MusicDiscovery {
  constructor(private store: Store, private music: Music, private knowledge: Knowledge,
    private assertLive: (context: RadioContext, signal?: AbortSignal) => void) {}

  async search(context: RadioContext, input: { query: string; limit: number }, signal: AbortSignal) {
    this.assertLive(context, signal);
    const tracks = await this.music.search(input.query, input.limit, signal);
    this.assertLive(context, signal);
    const candidates = this.register(context, tracks);
    return { ok: true, candidates, ...(candidates.length === 0 ? {
      guidance: "No matches. Use a short artist name, song title or single genre; not a scene description or playlist sentence.",
    } : {}) };
  }

  register(context: RadioContext, tracks: Track[]) {
    this.assertLive(context);
    return this.store.change(context.sessionId, (state) => {
      const candidates = tracks.map((track) => ({ id: randomUUID(), requestId: context.requestId, track }));
      state.candidates.push(...candidates);
      state.candidates = state.candidates.slice(-64);
      const feedback = this.knowledge.config<Record<string, string>>("trackFeedback", {});
      const listening = this.knowledge.listening();
      return candidates.map((c) => ({ candidateId: c.id, ...c.track,
        explicitFeedback: feedback[c.track.id] ?? null,
        recentlySkipped: listening.filter((item) => item.track.id === c.track.id && item.action === "skipped").length,
      })).sort((a, b) => Number(b.explicitFeedback === "like") - Number(a.explicitFeedback === "like") ||
        Number(a.explicitFeedback === "dislike") - Number(b.explicitFeedback === "dislike"));
    });
  }

  async inspect(context: RadioContext, candidateIds: string[], signal: AbortSignal) {
    this.assertLive(context, signal);
    const results = [];
    for (const id of candidateIds) {
      const candidate = candidateFor(this.store.read(context.sessionId), id, context);
      const resource = await this.music.inspect(candidate.track, signal);
      this.assertLive(context, signal);
      this.store.change(context.sessionId, (state) => { candidateFor(state, id, context).resource = resource; });
      results.push({ candidateId: id, title: candidate.track.title, artist: candidate.track.artist,
        availability: resource.availability,
        playableCandidate: resourceAllowed(resource, this.store.read(context.sessionId)),
        playableDurationMs: resource.playableDurationMs, reason: resource.reason });
    }
    return { ok: true, results };
  }
}
