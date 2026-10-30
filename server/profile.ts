import { z } from "zod";
import type { Track } from "../src/protocol.js";

export const PreferenceSchema = z.object({
  dimension: z.enum(["artist", "track", "genre", "language", "instrument", "vocal", "energy"]),
  value: z.string().trim().min(1).max(100),
  polarity: z.enum(["like", "dislike"]),
});
export const normalize = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase();
export const artistNames = (track: Track) => track.artist.split(/\s*[,、]\s*/).map(normalize).filter(Boolean);
export const preferenceKey = (preference: z.infer<typeof PreferenceSchema>, scope: string) =>
  JSON.stringify([preference.dimension, normalize(preference.value), normalize(scope)]);

export const RecommendationInput = z.object({
  purpose: z.enum(["cards", "queue"]).default("cards"),
  scope: z.string().trim().max(100).default("general"),
  // The model translates situations into catalog keywords, not fabricated acoustic metadata.
  queries: z.array(z.string().trim().min(1).max(100)).max(3).default([]),
  artist: z.string().trim().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(8).default(6),
});
