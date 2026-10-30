import { z } from "zod";
import { tool } from "langchain";
import type { MusicDiscovery } from "../music-discovery.js";
import type { ToolWrapper } from "./runtime.js";
import type { RecommendationService } from "../recommendation.js";
import { RecommendationInput } from "../profile.js";

export function musicTools(discovery: MusicDiscovery, wrap: ToolWrapper, recommendation: RecommendationService) {
  return [
    tool(wrap("recommend_music", async (input, runtime) => recommendation.recommend(runtime.context, input, runtime.signal!)), {
      name: "recommend_music",
      description: "Personalized candidate selection for both chat recommendations and queue refill. Uses scoped profile, dislikes, imports, recent listening and diversity. Supply up to 3 short catalog keywords from the user's current situation, scope general/work/rest/sleep/exercise. Set artist only for an explicit artist constraint. Does not change playback or queue. Metadata does not verify audio style.",
      schema: RecommendationInput,
    }),
    tool(wrap("search_music", async (input, runtime) => runtime.context.background
      ? { ok: false, code: "USE_PERSONALIZED_RECOMMENDATION", guidance: "Use recommend_music for background refill." }
      : discovery.search(runtime.context, input, runtime.signal!)), {
      name: "search_music",
      description: "Search the real catalog. Title and artist metadata are evidence; do not fabricate track IDs or URLs.",
      schema: z.object({ query: z.string().min(1).max(160), limit: z.number().int().min(1).max(8).default(5) }),
    }),
    tool(wrap("inspect_music", async ({ candidateIds }, runtime) => discovery.inspect(runtime.context, candidateIds, runtime.signal!)), {
      name: "inspect_music",
      description: "Inspect candidates before queue changes. Previews are playable when allowPreview is enabled; no resource or disallowed preview needs another candidate. Unknown causes stay unknown.",
      schema: z.object({ candidateIds: z.array(z.string()).min(1).max(8) }),
    }),
  ];
}
