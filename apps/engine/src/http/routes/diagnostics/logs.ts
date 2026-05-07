// Engine log-tail endpoints.
//
//   GET /v1/diagnostics/logs              — paginated window
//   GET /v1/diagnostics/logs/stream       — SSE live tail
//
// Both backed by the in-memory `logRing` populated by every
// `logger.*` call. Exists so an operator running `sk logs --follow`
// can correlate sk-side errors with engine-side log lines without
// SSH-ing into the engine container. Issue #149 — operator
// observability of migrate / seed / drift events specifically.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { logRing } from "../../../observability/index.ts";
import type { AppEnv } from "../../openapi.ts";

const LogEntrySchema = z
  .object({
    ts: z.number().int(),
    level: z.string(),
    module: z.string().optional(),
    action: z.string().optional(),
    msg: z.string().optional(),
    fields: z.record(z.string(), z.unknown()),
  })
  .openapi("LogRingEntry");

const LogTailQuery = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(2000).optional(),
  module: z.string().optional(),
  action: z.string().optional(),
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),
});

const LogTailResponse = z
  .object({
    entries: z.array(LogEntrySchema),
    /** Operator polls the next window with `?since=<this>`. */
    next_since_ms: z.number().int(),
    capacity: z.number().int(),
    size: z.number().int(),
  })
  .openapi("LogTailResponse");

const tailRoute = createRoute({
  method: "get",
  path: "/v1/diagnostics/logs",
  tags: ["diagnostics"],
  summary: "Paginated tail of the engine's in-memory log ring",
  security: [{ bearerAuth: [] }],
  request: { query: LogTailQuery },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: LogTailResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerLogsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(tailRoute, async (c) => {
    const q = c.req.valid("query");
    const opts: Parameters<typeof logRing.tail>[0] = {};
    if (q.since !== undefined) opts.since_ms = q.since;
    if (q.limit !== undefined) opts.limit = q.limit;
    if (q.module) opts.module = q.module;
    if (q.action) opts.action = q.action;
    if (q.level) opts.min_level = q.level;
    const entries = logRing.tail(opts);
    const lastTs = entries.length > 0 ? entries[entries.length - 1]!.ts : (q.since ?? 0);
    return c.json(
      {
        entries: entries.map((e) => ({
          ts: e.ts,
          level: e.level,
          ...(e.module !== undefined ? { module: e.module } : {}),
          ...(e.action !== undefined ? { action: e.action } : {}),
          ...(e.msg !== undefined ? { msg: e.msg } : {}),
          fields: e.fields,
        })),
        next_since_ms: lastTs + 1,
        capacity: logRing.capacity(),
        size: logRing.size(),
      },
      200,
    );
  });

  // SSE live tail. Hand-rolled because @hono/zod-openapi's `c.json`
  // doesn't model streaming responses; we register the SSE route
  // outside the OpenAPI surface.
  app.get("/v1/diagnostics/logs/stream", (c) => {
    const since = Number(c.req.query("since") ?? "0") || 0;
    const moduleFilter = c.req.query("module") ?? null;
    const actionFilter = c.req.query("action") ?? null;
    const levelFilter = c.req.query("level") ?? null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        const send = (event: string, data: unknown): void => {
          controller.enqueue(enc.encode(`event: ${event}\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        // 1. Catch-up replay: any buffered entries newer than `since`.
        const opts: Parameters<typeof logRing.tail>[0] = { since_ms: since, limit: 1000 };
        if (moduleFilter) opts.module = moduleFilter;
        if (actionFilter) opts.action = actionFilter;
        if (levelFilter) opts.min_level = levelFilter;
        for (const entry of logRing.tail(opts)) {
          send("log", entry);
        }

        // 2. Live subscription. Filtered server-side so the client
        // doesn't pay for entries it would have dropped.
        const unsub = logRing.subscribe((entry) => {
          if (moduleFilter && entry.module !== moduleFilter) return;
          if (actionFilter && entry.action !== actionFilter) return;
          if (levelFilter) {
            const weights: Record<string, number> = {
              trace: 10,
              debug: 20,
              info: 30,
              warn: 40,
              error: 50,
              fatal: 60,
            };
            const w = weights[entry.level.toLowerCase()] ?? 0;
            const min = weights[levelFilter] ?? 0;
            if (w < min) return;
          }
          try {
            send("log", entry);
          } catch {
            /* controller closed — handled below */
          }
        });

        // 3. Heartbeat every 15 s so proxies don't half-close idle streams.
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`: heartbeat ${Date.now()}\n\n`));
          } catch {
            clearInterval(heartbeat);
            unsub();
          }
        }, 15_000);
        (heartbeat as unknown as { unref?: () => void }).unref?.();

        // Tear down when the client disconnects.
        const signal = c.req.raw.signal;
        signal.addEventListener("abort", () => {
          clearInterval(heartbeat);
          unsub();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Cloudflare / Caddy proxy hint to disable buffering.
        "x-accel-buffering": "no",
      },
    });
  });
}
