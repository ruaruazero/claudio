import type { ToolRuntime } from "@langchain/core/tools";
import type { contextSchema } from "../radio-contracts.js";
import { Fault } from "../store.js";

export type Runtime = ToolRuntime<unknown, typeof contextSchema>;
type Handler = (input: any, runtime: Runtime) => Promise<unknown>;
export type ToolWrapper = (name: string, handler: Handler) => Handler;

export function toolLifecycle(options: {
  assertLive: (runtime: Runtime) => void;
  event: (runtime: Runtime, name: string, phase: "started" | "completed" | "failed",
    durationMs?: number, code?: string) => void;
}): ToolWrapper {
  return (name, handler) => async (input, runtime) => {
    options.assertLive(runtime);
    const started = Date.now();
    options.event(runtime, name, "started");
    try {
      const result = await handler(input, runtime);
      options.event(runtime, name, "completed", Date.now() - started);
      return result;
    } catch (error) {
      runtime.signal?.throwIfAborted();
      options.event(runtime, name, "failed", Date.now() - started, error instanceof Fault ? error.code : "UPSTREAM_ERROR");
      return { ok: false, code: error instanceof Fault ? error.code : "UPSTREAM_ERROR",
        guidance: "Read the result and adjust within the remaining budget. Do not claim success." };
    }
  };
}
