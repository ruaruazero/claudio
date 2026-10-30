import { z } from "zod";
import { tool } from "langchain";
import { MemoryInput, type Knowledge } from "../knowledge.js";
import { PreferenceSchema } from "../profile.js";
import type { ToolWrapper } from "./runtime.js";

export function memoryTools(knowledge: Knowledge, wrap: ToolWrapper) {
  return [
    tool(wrap("recall_memory", async ({ query, scope }) => ({
      ...knowledge.personalContext(query, scope), items: knowledge.recall(query),
    })), {
      name: "recall_memory",
      description: "Recall evidence-based personal memories; inferred patterns are uncertain, temporary context expires.",
      schema: z.object({ query: z.string().max(200), scope: z.string().max(100).optional() }),
    }),
    tool(wrap("propose_memory_update", async ({ items }, runtime) => knowledge.propose(runtime.context, items)), {
      name: "propose_memory_update",
      description: "Propose up to 4 evidence-backed personal memories from this user's current message. Include its actual message id in sourceIds; never assistant text. Preference requires dimension/value/polarity, one per item; default scope general, work/rest/sleep/exercise when conditional. Temporary activities are context; meaningful personal experiences are episode, durable facts are fact. Use playerAtMessage for 'this song', never infer a whole artist from one liked song. Rhythm needs 3 distinct local dates. No secrets, invented facts or one-time play requests. Latest explicit correction supersedes the same preference key; unrelated preferences coexist. System validates before saving.",
      schema: z.object({ items: z.array(MemoryInput).min(1).max(4) }),
    }),
    tool(wrap("request_memory_change", async (input, runtime) => knowledge.requestChange(runtime.context, input)), {
      name: "request_memory_change",
      description: "Remember, correct or forget ONLY on the current user's explicit request. Find the exact targetId with recall_memory before correcting/forgetting. For preferences supply structured preference. Do not claim success until saved.",
      schema: z.object({ operation: z.enum(["remember", "correct", "forget"]),
        text: z.string().min(1).max(500), scope: z.string().max(100).default("general"),
        targetId: z.string().optional(), preference: PreferenceSchema.optional() }),
    }),
  ];
}
