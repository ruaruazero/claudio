import { randomUUID } from "node:crypto";
import { Fault, Store } from "./store.js";
import { candidateFor, type RadioContext } from "./radio-contracts.js";
import { assertPublicReply } from "./model-output.js";

export class ConversationService {
  constructor(private store: Store) {}

  send(context: RadioContext, toolCallId: string, input: { text: string; candidateIds: string[] }) {
    if (context.background) throw new Fault("BACKGROUND_MESSAGE_DENIED");
    assertPublicReply(input.text);
    return this.store.change(context.sessionId, (state, emit) => {
      const operation = `message:${context.requestId}:${toolCallId}`;
      this.store.bindOperation(context.sessionId, operation, "message", input);
      if (Object.hasOwn(state.operations, operation)) return state.operations[operation];
      if (state.messages.filter((m) => m.role === "assistant" && m.requestId === context.requestId).length >= 3) {
        throw new Fault("MESSAGE_LIMIT");
      }
      const tracks = [...new Set(input.candidateIds)].map((id) => {
        const candidate = candidateFor(state, id, context);
        return { ...candidate.track, ...(candidate.resource ? {
          availability: candidate.resource.availability, playableDurationMs: candidate.resource.playableDurationMs,
        } : {}) };
      });
      const message = { id: randomUUID(), requestId: context.requestId, role: "assistant" as const,
        source: "model" as const, text: input.text, ...(tracks.length ? { tracks } : {}),
        status: "complete" as const, createdAt: new Date().toISOString() };
      state.messages.push(message);
      emit({ type: "reply.final", requestId: context.requestId, payload: message });
      const result = { ok: true, messageId: message.id,
        guidance: "Delivered. Send another only for new content. Do not repeat these messages in the final response." };
      state.operations[operation] = result;
      return result;
    });
  }
}
