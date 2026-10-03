// Audit log read surface.
//
//   GET  /v1/audit-log               — cursor-paginated list
//   GET  /v1/audit-log/:id            — fetch a single entry
//   GET  /v1/audit-log/export.ndjson  — streaming ndjson export
//
// Everything here is gated on the `audit:read` RBAC permission. The
// list + export endpoints share a filter schema so operators can
// develop queries against the interactive surface and then rerun them
// for SOC2 evidence collection against the export endpoint.
//
// Cursor design: pages are ordered newest first. When the response
// fills the requested page size, `next_cursor` carries an OPAQUE keyset
// cursor — the last row's timestamp AND its id — and the follow-up
// request passes it back verbatim as `cursor=<cursor>`.
//
// This comment used to claim ties "are broken by id in the underlying
// SELECT so the cursor never skips a row". The ORDER BY did break ties;
// the CURSOR did not carry the id, so the next page asked for
// `ts < <tie>` and skipped every remaining member of the group. The
// prose was true about the sort and false about the walk, which is the
// hardest kind of comment to catch. Measured before the fix: 6 rows of
// 15 reached by a full walk. Do not reduce this cursor to a timestamp.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { stream as honoStream } from "hono/streaming";
import { ErrorSchema, IdParam, paginatedResponse } from "../../api/common-schemas.ts";
import type { AuditActorType, AuditResult } from "../../audit/index.ts";
import {
  AUDIT_CURSOR_PATTERN,
  type AuditQueryFilters,
  getAuditRowById,
  queryAuditLog,
  serializeAuditEntry,
  streamAuditLog,
} from "../../audit/index.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const AuditEntrySchema = z
  .object({
    id: z.string(),
    ts: z.string(),
    tenant_id: z.string(),
    actor_type: z.string(),
    actor_id: z.string().nullable(),
    action: z.string(),
    resource_type: z.string(),
    resource_id: z.string().nullable(),
    result: z.string(),
    trace_id: z.string().nullable(),
    ip: z.string().nullable(),
    user_agent: z.string().nullable(),
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
    reason: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .openapi("AuditEntry");

const ListResponse = paginatedResponse(AuditEntrySchema, "AuditLogListResponse");

// ---------- Query shape ----------

const FilterQuery = z
  .object({
    action: z.string().optional(),
    actor_id: z.string().uuid().optional(),
    actor_type: z.enum(["user", "system_account", "system"]).optional(),
    resource_type: z.string().optional(),
    resource_id: z.string().optional(),
    result: z.enum(["success", "denied", "error"]).optional(),
    trace_id: z.string().optional(),
    ts_from: z.string().datetime().optional(),
    ts_to: z.string().datetime().optional(),
  })
  .openapi("AuditLogFilterQuery");

const ListQuery = FilterQuery.extend({
  limit: z.coerce.number().int().positive().max(500).optional(),
  // OPAQUE cursor, echoed back from a previous `next_cursor`. Not a
  // datetime: it carries the timestamp AND the tie-breaking id
  // (`<ts>|<uuid>`). Declaring it `.datetime()` would reject every
  // correct cursor, and a bare timestamp is exactly the shape that
  // silently dropped rows.
  //
  // Opaque to this layer, but not unchecked: dropping `.datetime()` also
  // dropped the only shape check, so `cursor=abc|def` walked through to
  // `'abc'::timestamptz` and came back as a 500 in the operator diagnostics
  // register (LOCAL-SK-CURSOR-MUELL-500). The pattern is the audit module's
  // own definition of the cursor — imported, not restated here, so the
  // validator and the parser cannot drift.
  cursor: z
    .string()
    .min(1)
    .max(128)
    .regex(AUDIT_CURSOR_PATTERN, "must be a cursor returned by next_cursor (<ts>|<uuid>)")
    .optional(),
}).openapi("AuditLogListQuery");

// ---------- OpenAPI routes ----------

const listRoute = createRoute({
  method: "get",
  path: "/v1/audit-log",
  tags: ["audit"],
  summary: "List audit log entries",
  security: [{ bearerAuth: [] }],
  request: { query: ListQuery },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ListResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getRouteSpec = createRoute({
  method: "get",
  path: "/v1/audit-log/{id}",
  tags: ["audit"],
  summary: "Fetch a single audit log entry",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: AuditEntrySchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------- Helpers ----------

function parseActions(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts : undefined;
}

interface RawFilterQuery {
  action?: string | undefined;
  actor_id?: string | undefined;
  actor_type?: "user" | "system_account" | "system" | undefined;
  resource_type?: string | undefined;
  resource_id?: string | undefined;
  result?: "success" | "denied" | "error" | undefined;
  trace_id?: string | undefined;
  ts_from?: string | undefined;
  ts_to?: string | undefined;
}

function filtersFromQuery(tenant_id: string, q: RawFilterQuery): AuditQueryFilters {
  const f: AuditQueryFilters = { tenant_id };
  const actions = parseActions(q.action);
  if (actions) f.actions = actions;
  if (q.actor_id) f.actor_id = q.actor_id;
  if (q.actor_type) f.actor_type = q.actor_type as AuditActorType;
  if (q.resource_type) f.resource_type = q.resource_type;
  if (q.resource_id) f.resource_id = q.resource_id;
  if (q.result) f.result = q.result as AuditResult;
  if (q.trace_id) f.trace_id = q.trace_id;
  if (q.ts_from) f.ts_from = new Date(q.ts_from);
  if (q.ts_to) f.ts_to = new Date(q.ts_to);
  return f;
}

// ---------- Registration ----------

export function registerAuditLogRoutes(app: OpenAPIHono<AppEnv>): void {
  // Permission gate — list + show + export all require audit:read.
  app.use("/v1/audit-log", requirePermission("audit:read"));
  app.use("/v1/audit-log/*", requirePermission("audit:read"));

  // ----- ndjson export. Registered BEFORE the openapi `/:id` spec so
  // Hono's path matcher resolves `/v1/audit-log/export.ndjson` here
  // instead of attempting to parse `export.ndjson` as a uuid. The
  // filters and permission gate mirror the list endpoint exactly.
  app.get("/v1/audit-log/export.ndjson", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const rawQ = c.req.query();
    const filters = filtersFromQuery(principal.tenant_id, {
      action: rawQ.action,
      actor_id: rawQ.actor_id,
      actor_type: rawQ.actor_type as "user" | "system_account" | "system" | undefined,
      resource_type: rawQ.resource_type,
      resource_id: rawQ.resource_id,
      result: rawQ.result as "success" | "denied" | "error" | undefined,
      trace_id: rawQ.trace_id,
      ts_from: rawQ.ts_from,
      ts_to: rawQ.ts_to,
    });
    c.header("Content-Type", "application/x-ndjson");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Transfer-Encoding", "chunked");
    return honoStream(c, async (s) => {
      const encoder = new TextEncoder();
      for await (const row of streamAuditLog(db, filters)) {
        await s.write(encoder.encode(`${JSON.stringify(serializeAuditEntry(row))}\n`));
      }
    });
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const filters = filtersFromQuery(principal.tenant_id, q);
    const limit = q.limit ?? 50;
    // `cursor` is passed through VERBATIM. It used to be parsed into a
    // `Date` here, which threw away the microseconds Postgres stores and
    // the id that breaks a timestamp tie — between them, 9 rows in 15
    // vanished from a full walk. The cursor is opaque to this layer now.
    const opts: { limit: number; cursor?: string } = { limit };
    if (q.cursor) opts.cursor = q.cursor;
    const { items, next_cursor } = await queryAuditLog(db, filters, opts);
    return c.json(
      {
        items: items.map(serializeAuditEntry) as z.infer<typeof AuditEntrySchema>[],
        next_cursor,
      },
      200,
    );
  });

  app.openapi(getRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const row = await getAuditRowById(db, principal.tenant_id, id);
    if (!row) throw new NotFoundError("audit_entry");
    return c.json(serializeAuditEntry(row) as z.infer<typeof AuditEntrySchema>, 200);
  });
}
