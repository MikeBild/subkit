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
    actor_type: z.enum(["user", "system_account", "system", "unknown"]),
    actor_id: z.string().nullable(),
    action: z.string(),
    resource_type: z.string(),
    resource_id: z.string().nullable(),
    resource_name: z.string().nullable().openapi({
      description: "Resource name recorded in the event snapshot, or null when not recorded.",
    }),
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

const FilterQuery = z
  .object({
    action: z.string().optional(),
    actor_id: z.string().uuid().optional(),
    actor_type: z.enum(["user", "system_account", "system", "unknown"]).optional(),
    resource_type: z.string().optional(),
    resource_types: z.string().max(2000).optional(),
    resource_id: z.string().optional(),
    result: z.enum(["success", "denied", "error"]).optional(),
    trace_id: z.string().optional(),
    ts_from: z.string().datetime().optional(),
    ts_to: z.string().datetime().optional(),
  })
  .openapi("AuditLogFilterQuery");

const ListQuery = FilterQuery.extend({
  limit: z.coerce.number().int().positive().max(500).optional(),
  cursor: z
    .string()
    .min(1)
    .max(128)
    .regex(AUDIT_CURSOR_PATTERN, "must be a cursor returned by next_cursor (<ts>|<uuid>)")
    .optional(),
}).openapi("AuditLogListQuery");

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
  actor_type?: "user" | "system_account" | "system" | "unknown" | undefined;
  resource_type?: string | undefined;
  resource_types?: string | undefined;
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
  const resourceTypes = parseActions(q.resource_types);
  if (resourceTypes) f.resource_types = resourceTypes;
  if (q.resource_id) f.resource_id = q.resource_id;
  if (q.result) f.result = q.result as AuditResult;
  if (q.trace_id) f.trace_id = q.trace_id;
  if (q.ts_from) f.ts_from = new Date(q.ts_from);
  if (q.ts_to) f.ts_to = new Date(q.ts_to);
  return f;
}

export function registerAuditLogRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/audit-log", requirePermission("audit:read"));
  app.use("/v1/audit-log/*", requirePermission("audit:read"));

  app.get("/v1/audit-log/export.ndjson", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const rawQ = c.req.query();
    const filters = filtersFromQuery(principal.tenant_id, {
      action: rawQ.action,
      actor_id: rawQ.actor_id,
      actor_type: rawQ.actor_type as "user" | "system_account" | "system" | "unknown" | undefined,
      resource_type: rawQ.resource_type,
      resource_types: rawQ.resource_types,
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
