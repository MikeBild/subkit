import { DIAGNOSTICS_LOG_STREAM_PATH } from "@cli-core/diagnostics-paths.ts";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import {
  AuditAction,
  auditAwait,
  DiagnosticsLogsTailedMetadataSchema,
} from "../../../audit/index.ts";
import type { ResolvedPrincipal } from "../../../auth/index.ts";
import { type Db, getDb } from "../../../db/client.ts";
import { isEntryVisibleToTenant, levelWeight, logRing } from "../../../observability/index.ts";
import { principalHolds } from "../../../rbac/index.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

const LOG_STREAM_PATH = DIAGNOSTICS_LOG_STREAM_PATH;

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
  include_engine: boolean,
  defaults: { limit?: number } = {},
): FilterOpts & { visible_to_tenant: string; include_engine: boolean } {
  const opts: FilterOpts & { visible_to_tenant: string; include_engine: boolean } = {
    visible_to_tenant: principal_tenant_id,
    include_engine,
  };
  if (q.since !== undefined) opts.since_ms = q.since;
  if (q.limit !== undefined) opts.limit = q.limit;
  else if (defaults.limit !== undefined) opts.limit = defaults.limit;
  if (q.module) opts.module = q.module;
  if (q.action) opts.action = q.action;
  if (q.level) opts.min_level = q.level;
  return opts;
}

function seesEngineLogs(db: Db, principal: ResolvedPrincipal): Promise<boolean> {
  return principalHolds(db, principal, "settings:read:global");
}

export function registerLogsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(tailRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db") ?? getDb();
    const q = c.req.valid("query");
    const opts = buildTailOpts(q, principal.tenant_id, await seesEngineLogs(db, principal));
    const entries = logRing.tail(opts);
    const lastTs = entries.length > 0 ? entries[entries.length - 1]!.ts : (q.since ?? 0);

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
    const includeEngine = await seesEngineLogs(db, principal);
    const tailOpts = buildTailOpts(q, principal.tenant_id, includeEngine, { limit: 1000 });
    const minLevelWeight = q.level ? levelWeight(q.level) : 0;

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

        for (const entry of logRing.tail(tailOpts)) {
          send("log", entry);
        }

        const unsub = logRing.subscribe((entry) => {
          if (q.since !== undefined && entry.ts < q.since) return;
          if (q.module && entry.module !== q.module) return;
          if (q.action && entry.action !== q.action) return;
          if (minLevelWeight > 0 && levelWeight(entry.level) < minLevelWeight) return;
          if (!isEntryVisibleToTenant(entry, principal.tenant_id, includeEngine)) return;
          try {
            send("log", entry);
          } catch {}
        });

        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`: heartbeat ${Date.now()}\n\n`));
          } catch {
            clearInterval(heartbeat);
            unsub();
          }
        }, SSE_HEARTBEAT_MS);
        (heartbeat as unknown as { unref?: () => void }).unref?.();

        const signal = c.req.raw.signal;
        signal.addEventListener("abort", () => {
          clearInterval(heartbeat);
          unsub();
          try {
            controller.close();
          } catch {}
        });
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });
}
