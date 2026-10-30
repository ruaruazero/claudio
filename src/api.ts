import { z } from "zod";

export async function request<T extends z.ZodTypeAny>(
  base: string,
  path: string,
  schema: T,
  options: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<z.infer<T>> {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 8000), ...(options.signal ? [options.signal] : [])]),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const data = await response.json();
      if (typeof data.error === "string") detail = data.error.slice(0, 200);
    } catch { /* An HTTP error may have no JSON body. */ }
    throw new Error(detail || `请求失败 (${response.status})`);
  }
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new Error("后端返回格式与验证协议不一致。");
  return parsed.data;
}

export function eventUrl(base: string, sessionId: string, sequence: number): string {
  return `${base}/sessions/${encodeURIComponent(sessionId)}/events?after=${sequence}`;
}
