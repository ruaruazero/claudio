import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Track } from "../src/protocol.js";
import type { Music } from "./music.js";
import type { Knowledge } from "./knowledge.js";
import type { MusicDiscovery } from "./music-discovery.js";
import { Fault, Store } from "./store.js";
import type { RadioContext } from "./radio-contracts.js";
import { RecommendationInput, artistNames, normalize } from "./profile.js";

export class RecommendationService {
  constructor(private store: Store, private music: Music, private knowledge: Knowledge,
    private discovery: MusicDiscovery, private assertLive: (context: RadioContext, signal?: AbortSignal) => void) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS lab_recommendations(id TEXT PRIMARY KEY,session_id TEXT,at TEXT,body TEXT)`);
  }

  traces(sessionId: string) {
    return (this.store.db.prepare("SELECT body FROM lab_recommendations WHERE session_id=? ORDER BY at DESC,rowid DESC LIMIT 10")
      .all(sessionId) as { body: string }[]).map(row => JSON.parse(row.body));
  }

  async recommend(context: RadioContext, raw: z.input<typeof RecommendationInput>, signal: AbortSignal) {
    const input = RecommendationInput.parse(raw);
    this.assertLive(context, signal);
    const profile = this.knowledge.profile(input.scope);
    const artist = input.artist && normalize(input.artist);
    const likes = profile.filter(tag => tag.polarity === "like");
    const seedQueries = likes.flatMap(tag => ["artist", "genre", "instrument"].includes(tag.dimension) ? [tag.value] :
      tag.dimension === "track" && tag.entities.length ? [tag.entities[0]] : []);
    const imports = this.knowledge.importedTracks();
    // Explicit artist requests narrow the pool; otherwise keep one slot for a personal seed.
    const queries = [...new Set(artist ? [input.artist!] :
      [...input.queries.slice(0, seedQueries.length ? 2 : 3), ...seedQueries,
        ...(seedQueries.length || input.queries.length ? [] : imports.slice(0, 2).map(track => track.artist)),
        ...(seedQueries.length || input.queries.length || imports.length ? [] : ["jazz", "lofi", "acoustic"])])].slice(0, 3);
    const results = await Promise.allSettled(queries.map(query =>
      this.music.search(query, 8, AbortSignal.any([signal, AbortSignal.timeout(9000)]))));
    this.assertLive(context, signal);
    const pool = new Map<string, { track: Track; origins: string[] }>();
    const add = (track: Track, origin: string) => {
      const item = pool.get(track.id);
      if (item) item.origins.push(origin); else pool.set(track.id, { track, origins: [origin] });
    };
    results.forEach((result, index) => {
      if (result.status === "fulfilled") result.value.forEach(track => add(track, queries[index]));
    });
    // Imports are personal candidates, not assumed likes. Resource inspection still happens later.
    for (const track of imports.slice(0, 160)) add(track, "import");
    const state = this.store.read(context.sessionId);
    const occupied = new Set([state.radio.current?.id, ...state.radio.queue.map(track => track.id)]);
    const recent = this.knowledge.listening();
    const feedback = this.knowledge.config<Record<string, string>>("trackFeedback", {});
    let excluded = 0;
    const scored = [...pool.values()].flatMap(({ track, origins }) => {
      const artists = artistNames(track);
      if (occupied.has(track.id) || (artist && !artists.includes(artist))) { excluded++; return []; }
      const matches = profile.filter(tag => tag.dimension === "track" ? tag.value === track.id :
        tag.dimension === "artist" && artists.includes(normalize(tag.value)));
      const blocked = feedback[track.id] === "dislike" || matches.some(tag => tag.polarity === "dislike");
      // Only a specific current artist request can override an artist-level dislike.
      if (blocked && !(artist && feedback[track.id] !== "dislike" &&
        !matches.some(tag => tag.dimension === "track" && tag.polarity === "dislike"))) { excluded++; return []; }
      const personal = matches.filter(tag => tag.polarity === "like");
      const affinity = likes.filter(tag => tag.dimension === "track" && tag.value !== track.id &&
        tag.entities.some(entity => artists.includes(normalize(entity))));
      const recentCount = recent.filter(item => item.track.id === track.id && ["completed", "skipped"].includes(item.action)).length;
      const skips = recent.filter(item => item.track.id === track.id && item.action === "skipped" && !item.automatic).length;
      const reasons: string[] = [];
      if (personal.length) reasons.push("profile_match");
      if (affinity.length) reasons.push("liked_track_artist_affinity");
      if (feedback[track.id] === "like") reasons.push("explicit_like");
      if (origins.includes("import")) reasons.push("imported_candidate");
      const currentIntentMatch = origins.some(origin => input.queries.includes(origin));
      if (currentIntentMatch) reasons.push("current_intent");
      if (recentCount) reasons.push("recent_penalty");
      if (skips) reasons.push("skip_penalty");
      const score = personal.reduce((sum, tag) => sum + (tag.dimension === "track" ? 7 : 4) * tag.confidence, 0) +
        Math.min(2, affinity.length * 0.6) +
        (feedback[track.id] === "like" ? 5 : 0) + (currentIntentMatch ? 8 : 0) + (origins.includes("import") ? 0.5 : 0) -
        recentCount * 3 - skips * 1.5;
      return [{ track, score, personal: personal.length > 0 || feedback[track.id] === "like", reasons,
        memoryIds: [...personal, ...affinity].map(tag => tag.id), origins }];
    });
    const selected: typeof scored = [];
    const artistCount = new Map<string, number>();
    while (scored.length && selected.length < input.limit) {
      scored.sort((a, b) => (b.score - (artistCount.get(artistNames(b.track)[0]) ?? 0) * 5) -
        (a.score - (artistCount.get(artistNames(a.track)[0]) ?? 0) * 5) || a.track.id.localeCompare(b.track.id));
      // A single exploration slot, only when personal matches are available.
      const explore = !artist && input.limit >= 4 && selected.length === input.limit - 1 &&
        selected.some(item => item.personal) && selected.every(item => item.personal);
      const index = explore ? scored.findIndex(item => !item.personal && !item.reasons.includes("skip_penalty")) : 0;
      const next = scored.splice(index < 0 ? 0 : index, 1)[0];
      if (!artist && artistNames(next.track).some(name => (artistCount.get(name) ?? 0) >= 2)) continue;
      if (explore && !next.personal) next.reasons.push("exploration");
      selected.push(next);
      for (const name of artistNames(next.track)) artistCount.set(name, (artistCount.get(name) ?? 0) + 1);
    }
    if (!selected.length && results.every(result => result.status === "rejected") && !imports.length) {
      throw new Fault("MUSIC_NETWORK_OR_TIMEOUT", 502);
    }
    this.assertLive(context, signal);
    const trace = { id: randomUUID(), requestId: context.requestId, background: Boolean(context.background),
      at: new Date().toISOString(), scope: input.scope, purpose: input.purpose, queries,
      profileIds: profile.map(tag => tag.id), coldStart: !profile.length && !imports.length,
      partialSearchFailure: results.some(result => result.status === "rejected"), poolSize: pool.size, excluded,
      selected: selected.map(item => ({ trackId: item.track.id, score: item.score, reasons: item.reasons,
        memoryIds: item.memoryIds, origins: item.origins })) };
    return this.store.db.transaction(() => {
      const candidates = this.discovery.register(context, selected.map(item => item.track));
      this.store.db.prepare("INSERT INTO lab_recommendations VALUES (?,?,?,?)")
        .run(trace.id, context.sessionId, trace.at, JSON.stringify(trace));
      this.store.db.prepare("DELETE FROM lab_recommendations WHERE id NOT IN (SELECT id FROM lab_recommendations ORDER BY at DESC,rowid DESC LIMIT 200)").run();
      return { ok: true, candidates, traceId: trace.id, coldStart: trace.coldStart,
        partialSearchFailure: trace.partialSearchFailure,
        guidance: selected.length ? "Candidates only. For cards use send_message; queue writes require authorization and inspect_music. Do not narrate ranking or evidence." :
          "No suitable candidates. Simplify search keywords or ask a single preference question; do not silently reintroduce excluded tracks." };
    })();
  }
}
