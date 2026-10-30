import { isInternalReply } from "../src/model-output.js";
import { Fault } from "./store.js";

export function assertPublicReply(text: string) {
  if (!text.trim() || isInternalReply(text)) throw new Fault("MODEL_OUTPUT_PROTOCOL_ERROR", 502);
}
