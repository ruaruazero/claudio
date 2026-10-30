import { z } from "zod";
import { Fault, type State } from "./store.js";
import type { Resource } from "./music.js";

export const contextSchema = z.object({
  sessionId: z.string(), requestId: z.string(), memoryRevision: z.number().optional(),
  controlEpoch: z.number().optional(), selectionEpoch: z.number().optional(), background: z.boolean().optional(),
});
export type RadioContext = z.infer<typeof contextSchema>;
export const queueInput = z.object({
  candidateIds: z.array(z.string()).min(1).max(8),
  mode: z.enum(["replace", "append", "insert_next"]),
  timing: z.enum(["now", "after_current"]).default("now"),
  expectedQueueVersion: z.number().int().nonnegative(),
  intent: z.enum(["explicit_queue", "implicit_adaptation"]).optional(),
});
export const playbackInput = z.object({
  action: z.enum(["play", "pause", "stop", "next"]),
  expectedPlaybackVersion: z.number().int().nonnegative(),
});

export function assertWrite(context: RadioContext, state: State) {
  if (context.background) {
    if (context.selectionEpoch !== undefined && context.selectionEpoch !== state.selectionEpoch) {
      throw new Fault("SELECTION_SUPERSEDED");
    }
  } else if (context.controlEpoch !== undefined && context.controlEpoch !== state.controlEpoch) {
    throw new Fault("CONTROL_SUPERSEDED");
  }
}

export function resourceAllowed(resource: Resource, state: State) {
  return Boolean(resource.url) && resource.expiresAt > Date.now() &&
    resource.availability !== "requires_subscription" &&
    (resource.availability !== "preview_only" || state.settings.allowPreview);
}

export function candidateFor(state: State, id: string, context: RadioContext) {
  const candidate = state.candidates.find((item) => item.id === id && item.requestId === context.requestId);
  if (!candidate) throw new Fault("CANDIDATE_NOT_IN_THIS_REQUEST");
  return candidate;
}
