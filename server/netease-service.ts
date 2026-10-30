import Fastify from "fastify";
import { createRequire } from "node:module";
import { z } from "zod";

const require = createRequire(import.meta.url);
type ApiReply = { status: number; body: unknown };
type ApiMethod = (query: Record<string, unknown>) => Promise<ApiReply>;

// Expose only the read endpoints used by Claudio, on loopback.
export async function startNeteaseService(baseUrl: string) {
  const target = new URL(baseUrl);
  if (!["127.0.0.1", "localhost"].includes(target.hostname) ||
    target.protocol !== "http:" || target.pathname !== "/") {
    throw new Error("Embedded music service requires a loopback HTTP base URL.");
  }
  const api = require("@neteasecloudmusicapienhanced/api") as Record<string, ApiMethod>;
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  const common = {
    cookie: z.string().max(16_000).optional(),
    // Use the established eapi transport explicitly; do not depend on the
    // package's changing per-endpoint default or automatic unlocking.
    crypto: z.literal("eapi").default("eapi"),
    timeout: z.coerce.number().int().min(1000).max(8000).default(7000),
  };
  const register = (path: string, method: string, schema: z.AnyZodObject) => {
    app.post(path, async (request, reply) => {
      const query = schema.parse(request.body);
      try {
        const result = await api[method]({ ...query, unblock: "false" });
        return reply.code(result.status).send(result.body);
      } catch (error) {
        // SDK error objects can include cookies and request configuration.
        const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 502;
        return reply.code([401, 403, 429].includes(status) ? status : 502)
          .send({ code: status, message: "NETEASE_UPSTREAM_FAILED" });
      }
    });
  };
  register("/search", "search", z.object({
    ...common, keywords: z.string().min(1).max(160),
    limit: z.coerce.number().int().min(1).max(8).default(5), type: z.literal(1).default(1),
  }));
  register("/song/url/v1", "song_url_v1", z.object({
    ...common, id: z.string().regex(/^\d+$/), level: z.literal("standard").default("standard"),
  }));
  register("/song/url", "song_url", z.object({
    ...common, id: z.string().regex(/^\d+$/),
    br: z.coerce.number().int().min(96000).max(320000).default(128000),
  }));
  register("/song/detail", "song_detail", z.object({
    ...common, ids: z.string().regex(/^\d{1,20}$/),
  }));
  app.get("/health", async () => ({
    service: "claudio-netease", package: "@neteasecloudmusicapienhanced/api",
    version: "4.41.1", transport: "eapi", authenticated: Boolean(process.env.NETEASE_COOKIE),
  }));
  app.setErrorHandler((error, _, reply) =>
    reply.code(error instanceof z.ZodError ? 400 : 500).send({ error: "MUSIC_SERVICE_ERROR" }));
  await app.listen({ host: "127.0.0.1", port: Number(target.port || 80) });
  return app;
}
