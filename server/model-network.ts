import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Fault } from "./store.js";
import type { ModelAttempt } from "../src/protocol.js";

type Failure = {
  code: string; retryable: boolean;
  phase: ModelAttempt["networkPhase"]; networkCode?: string; status?: number; retryAfterMs?: number;
};
type AttemptScope = { signal: AbortSignal; failure?: Failure };
const attempts = new AsyncLocalStorage<AttemptScope>();
const networkCodes: Record<string, [string, Failure["phase"], boolean]> = {
  UND_ERR_CONNECT_TIMEOUT: ["MODEL_CONNECT_TIMEOUT", "connect", true],
  UND_ERR_HEADERS_TIMEOUT: ["MODEL_RESPONSE_TIMEOUT", "headers", true],
  UND_ERR_BODY_TIMEOUT: ["MODEL_RESPONSE_TIMEOUT", "body", true],
  ECONNRESET: ["MODEL_CONNECTION_RESET", "connection", true],
  EPIPE: ["MODEL_CONNECTION_RESET", "connection", true],
  UND_ERR_SOCKET: ["MODEL_CONNECTION_RESET", "connection", true],
  ECONNREFUSED: ["MODEL_CONNECTION_REFUSED", "connect", true],
  ENETUNREACH: ["MODEL_NETWORK_UNAVAILABLE", "connect", true],
  EHOSTUNREACH: ["MODEL_NETWORK_UNAVAILABLE", "connect", true],
  EAI_AGAIN: ["MODEL_DNS_FAILED", "dns", true],
  ENOTFOUND: ["MODEL_DNS_FAILED", "dns", false],
  CERT_HAS_EXPIRED: ["MODEL_TLS_FAILED", "tls", false],
  DEPTH_ZERO_SELF_SIGNED_CERT: ["MODEL_TLS_FAILED", "tls", false],
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: ["MODEL_TLS_FAILED", "tls", false],
  ERR_TLS_CERT_ALTNAME_INVALID: ["MODEL_TLS_FAILED", "tls", false],
};

export function modelFailure(error: unknown): Failure {
  const chain: Record<string, unknown>[] = [];
  let item = error;
  for (let i = 0; i < 8 && item && typeof item === "object"; i++) {
    chain.push(item as Record<string, unknown>);
    item = (item as { cause?: unknown }).cause;
  }
  const fault = chain.find((node) => node instanceof Fault) as Fault | undefined;
  if (fault) return { code: fault.code, retryable: false, phase: "unknown" };
  for (const node of chain) {
    if (typeof node.code !== "string" || !networkCodes[node.code]) continue;
    const [code, phase, retryable] = networkCodes[node.code];
    return { code, phase, retryable, networkCode: node.code };
  }
  const status = chain.find((node) => typeof node.status === "number")?.status as number | undefined;
  if (status !== undefined) return { status, phase: "http",
    code: status === 401 ? "MODEL_AUTH_FAILED" : status === 403 ? "MODEL_PERMISSION_DENIED" :
      status === 404 ? "MODEL_NOT_FOUND" : status === 402 ? "MODEL_BALANCE" :
      status === 408 ? "MODEL_REQUEST_TIMEOUT" : status === 429 ? "MODEL_RATE_LIMITED" :
        status >= 500 ? "MODEL_UNAVAILABLE" : "MODEL_PROTOCOL_ERROR",
    retryable: [408, 429, 500, 502, 503, 504].includes(status) };
  if (chain.some((node) => ["TimeoutError", "APIConnectionTimeoutError"].includes(String(node.name)))) {
    return { code: "MODEL_REQUEST_TIMEOUT", phase: "request", retryable: true };
  }
  if (chain.some((node) => node.name === "APIConnectionError")) {
    return { code: "MODEL_NETWORK_UNAVAILABLE", phase: "connection", retryable: true };
  }
  return { code: "MODEL_CALL_FAILED", phase: "unknown", retryable: false };
}

// Capture allowlisted facts before LangChain replaces the SDK error and drops its cause.
export function createModelFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const scope = attempts.getStore();
    const signal = scope ? AbortSignal.any([scope.signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal;
    try {
      const response = await fetcher(input, { ...init, signal });
      if (!response.ok && scope) {
        const failure = modelFailure({ status: response.status });
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(wait)) failure.retryAfterMs = Math.max(0, wait);
        }
        scope.failure = failure;
      }
      if (!response.body || !scope) return response;
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const item = await reader.read();
            if (item.done) controller.close(); else controller.enqueue(item.value);
          } catch (error) {
            scope.failure ??= modelFailure(error);
            if (scope.failure.phase === "unknown") scope.failure = {
              code: "MODEL_RESPONSE_INTERRUPTED", phase: "body", retryable: true,
            };
            controller.error(error);
          }
        },
        cancel(reason) { return reader.cancel(reason); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (scope) scope.failure = modelFailure(error);
      throw error;
    }
  };
}

export async function callModelWithRecovery<T>(
  operation: (signal: AbortSignal, attempt: number) => Promise<T>,
  options: { signal?: AbortSignal; onAttempt: (event: ModelAttempt) => void;
    timeoutMs?: number; retryDelayMs?: number },
): Promise<T> {
  const callId = crypto.randomUUID();
  for (let attempt = 1; attempt <= 2; attempt++) {
    options.signal?.throwIfAborted();
    const started = Date.now();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new DOMException("Model attempt timed out", "TimeoutError")),
      options.timeoutMs ?? 25_000);
    const signal = AbortSignal.any([timeout.signal, ...(options.signal ? [options.signal] : [])]);
    const scope: AttemptScope = { signal };
    options.onAttempt({ callId, attempt, phase: "started" });
    let wait = 0;
    try {
      const result = await attempts.run(scope, () => operation(signal, attempt));
      signal.throwIfAborted();
      options.onAttempt({ callId, attempt, phase: "completed", durationMs: Date.now() - started });
      return result;
    } catch (error) {
      options.signal?.throwIfAborted();
      const failure = timeout.signal.aborted
        ? { code: "MODEL_REQUEST_TIMEOUT", phase: "request" as const, retryable: true }
        : scope.failure ?? modelFailure(error);
      const retry = attempt === 1 && failure.retryable && (failure.retryAfterMs ?? 0) <= 5000;
      wait = Math.max(options.retryDelayMs ?? 500 + Math.floor(Math.random() * 500), failure.retryAfterMs ?? 0);
      options.onAttempt({ callId, attempt, phase: retry ? "retrying" : "failed",
        durationMs: Date.now() - started, code: failure.code, networkPhase: failure.phase,
        ...(failure.networkCode ? { networkCode: failure.networkCode } : {}),
        ...(failure.status ? { status: failure.status } : {}),
        ...(retry ? { retryInMs: wait } : {}) });
      if (!retry) {
        if (failure.code === "MODEL_CALL_FAILED") throw error;
        throw new Fault(failure.code, 502);
      }
    } finally { clearTimeout(timer); }
    await delay(wait, undefined, { signal: options.signal });
  }
  throw new Fault("MODEL_CALL_FAILED", 502);
}
