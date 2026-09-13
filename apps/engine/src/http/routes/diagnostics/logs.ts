// Engine log-tail endpoints.
//
//   GET /v1/diagnostics/logs              — paginated window
//   GET /v1/diagnostics/logs/stream       — SSE live tail (LOG_STREAM_PATH)
//
// Both backed by the in-memory `logRing` populated by every
// `logger.*` call. Exists so an operator running `sk logs --follow`
// can correlate sk-side errors with engine-side log lines without
// SSH-ing into the engine container — operator
// observability of migrate / seed / drift events specifically.
//
// Tenant scoping: the ring is process-wide but every read
// here filters entries to the principal's tenant + system-scope only,
// so a tenant-scoped admin cannot tail another tenant's request log.
// Each tail also writes a `DIAGNOSTICS_LOGS_TAILED` audit row.

import { DIAGNOSTICS_LOG_STREAM_PATH } from "@cli-core/diagnostics-paths.ts";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import { ErrorSchema } from "../../../api/common-schemas.ts";
import {
  AuditAction,
  auditAwait,
  DiagnosticsLogsTailedMetadataSchema,
} from "../../../audit/index.ts";
import { getDb } from "../../../db/client.ts";
import { isEntryVisibleToTenant, levelWeight, logRing } from "../../../observability/index.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

/** Path of the SSE live-tail route. Re-exported from the shared
 *  `cli-core` constant so the engine and the CLI cannot disagree. */
export const LOG_STREAM_PATH = DIAGNOSTICS_LOG_STREAM_PATH;

/** Idle heartbeat cadence on the SSE stream. Sub-30s so reverse proxies
 *  with default idle close (Caddy 30s, ALB 60s) don't half-close the
 *  stream during quiet periods. */
const SSE_HEARTBEAT_MS = 15_000;

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

/** Shared query schema — applied to both the JSON tail and the SSE
 *  stream so the two surfaces validate identically. */
const LogTailQuery = z
  .object({
    since: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().positive().max(2000).optional(),
    module: z.string().min(1).max(120).optional(),
    action: z.string().min(1).max(120).optional(),
    level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),
  })
  .openapi("LogTailQuery");

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
    400: {
      description: "Bad query parameters",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

interface FilterOpts {
  since_ms?: number;
  limit?: number;
  module?: string;
  action?: string;
  min_level?: string;
}

function buildTailOpts(
  q: z.infer<typeof LogTailQuery>,
  principal_tenant_id: string,
  defaults: { limit?: number } = {},
): FilterOpts & { visible_to_tenant: string } {
  const opts: FilterOpts & { visible_to_tenant: string } = {
    visible_to_tenant: principal_tenant_id,
  };
  if (q.since !== undefined) opts.since_ms = q.since;
  if (q.limit !== undefined) opts.limit = q.limit;
  else if (defaults.limit !== undefined) opts.limit = defaults.limit;
  if (q.module) opts.module = q.module;
  if (q.action) opts.action = q.action;
  if (q.level) opts.min_level = q.level;
  return opts;
}

export function registerLogsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(tailRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db") ?? getDb();
    const q = c.req.valid("query");
    const opts = buildTailOpts(q, principal.tenant_id);
    const entries = logRing.tail(opts);
    const lastTs = entries.length > 0 ? entries[entries.length - 1]!.ts : (q.since ?? 0);

    // Metadata is parsed through the Zod schema so a
    // future field rename / type change in `audit/types.ts` fails at
    // the route, not in production. `auditAwait` blocks the
    // response until the row is durable — diagnostics tails finish in
    // microseconds, so the latency cost is negligible compared with the
    // compliance benefit of guaranteeing the row.
    const metadata = DiagnosticsLogsTailedMetadataSchema.parse({
      mode: "json",
      returned: entries.length,
      ...(q.since !== undefined ? { since_ms: q.since } : {}),
      ...(q.module ? { module_filter: q.module } : {}),
      ...(q.action ? { action_filter: q.action } : {}),
      ...(q.level ? { level_filter: q.level } : {}),
    });
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind === "user" ? "user" : "system_account",
        actor_id: principal.id,
        action: AuditAction.DIAGNOSTICS_LOGS_TAILED,
        resource_type: "log_ring",
        resource_id: null,
        result: "success",
        metadata,
      },
      db,
    );

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
  // outside the OpenAPI surface but still validate its query bag with
  // the same Zod schema the JSON tail uses.
  app.get(LOG_STREAM_PATH, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db") ?? getDb();
    const parsed = LogTailQuery.safeParse({
      since: c.req.query("since"),
      limit: c.req.query("limit"),
      module: c.req.query("module"),
      action: c.req.query("action"),
      level: c.req.query("level"),
    });
    if (!parsed.success) {
      // Match the shared `ErrorSchema` envelope so the
      // CLI / MCP error adapters parse this 400 the same way they parse
      // every other engine error response.
      return c.json(
        {
          code: "validation_error",
          message: "invalid query parameters",
          details: {
            issues: parsed.error.issues.map((iss) => ({
              path: iss.path.join("."),
              message: iss.message,
            })),
          },
        },
        400,
      );
    }
    const q = parsed.data;
    const tailOpts = buildTailOpts(q, principal.tenant_id, { limit: 1000 });
    const minLevelWeight = q.level ? levelWeight(q.level) : 0;

    // Parse metadata through the schema, then
    // await the audit row before opening the stream.
    const metadata = DiagnosticsLogsTailedMetadataSchema.parse({
      mode: "stream",
      ...(q.since !== undefined ? { since_ms: q.since } : {}),
      ...(q.module ? { module_filter: q.module } : {}),
      ...(q.action ? { action_filter: q.action } : {}),
      ...(q.level ? { level_filter: q.level } : {}),
    });
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind === "user" ? "user" : "system_account",
        actor_id: principal.id,
        action: AuditAction.DIAGNOSTICS_LOGS_TAILED,
        resource_type: "log_ring",
        resource_id: null,
        result: "success",
        metadata,
      },
      db,
    );

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        const send = (event: string, data: unknown): void => {
          controller.enqueue(enc.encode(`event: ${event}\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        // 1. Catch-up replay: any buffered entries newer than `since`
        // that the principal is allowed to see.
        for (const entry of logRing.tail(tailOpts)) {
          send("log", entry);
        }

        // 2. Live subscription. Filter server-side so the operator
        // doesn't pay for entries it would have dropped, and so
        // tenant-A admins can never observe tenant-B request lines
        // mid-stream.
        const unsub = logRing.subscribe((entry) => {
          if (q.module && entry.module !== q.module) return;
          if (q.action && entry.action !== q.action) return;
          if (minLevelWeight > 0 && levelWeight(entry.level) < minLevelWeight) return;
          if (!isEntryVisibleToTenant(entry, principal.tenant_id)) return;
          try {
            send("log", entry);
          } catch {
            /* controller closed — handled below */
          }
        });

        // 3. Heartbeat so reverse proxies don't half-close idle streams.
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`: heartbeat ${Date.now()}\n\n`));
          } catch {
            clearInterval(heartbeat);
            unsub();
          }
        }, SSE_HEARTBEAT_MS);
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
