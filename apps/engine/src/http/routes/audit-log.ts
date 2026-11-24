import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { stream as honoStream } from "hono/streaming";
import { ErrorSchema, IdParam, paginatedResponse } from "../../api/common-schemas.ts";
import type { AuditActorType, AuditResult } from "../../audit/index.ts";
import {
  AUDIT_CURSOR_PATTERN,
  type AuditQueryFilters,
  getAuditRowById,
  queryAuditLog,
  searchAuditResources,
  serializeAuditEntry,
  streamAuditLog,
} from "../../audit/index.ts";
import { RequestSourceSchema } from "../../observability/index.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { type AppEnv, validationFailedResponse } from "../openapi.ts";

const AuditEntrySchema = z
  .object({
    id: z.string(),
    ts: z.string(),
    tenant_id: z.string(),
    actor_type: z.enum(["user", "system_account", "system", "unknown"]),
    actor_id: z.string().nullable(),
    api_key_id: z.string().uuid().nullable(),
    session_id: z.string().uuid().nullable(),
    recorded_api_key_id: z.string().uuid().nullable(),
    recorded_session_id: z.string().uuid().nullable(),
    access_type: z
      .enum([
        "api_key",
        "browser_session",
        "mcp_oauth",
        "token_exchange",
        "external_bearer",
        "task_run",
        "portal_token",
        "device_runner",
      ])
      .nullable(),
    oauth_client_id: z.string().nullable(),
    credential_origin: z.literal("cli_oauth_session").nullable(),
    request_source: RequestSourceSchema.nullable(),
    origin_source: RequestSourceSchema.nullable(),
    execution_source: RequestSourceSchema.nullable(),
    execution_id: z.string().uuid().nullable(),
    conversation_id: z.string().uuid().nullable(),
    workflow_id: z.string().uuid().nullable(),
    task_id: z.string().uuid().nullable(),
    task_run_id: z.string().uuid().nullable(),
    changed_fields: z.array(z.string()),
    changes: z.array(
      z.object({
        field: z.string(),
        before: z.union([z.string(), z.boolean()]),
        after: z.union([z.string(), z.boolean()]),
      }),
    ),
    action: z.string(),
    resource_type: z.string(),
    resource_id: z.string().nullable(),
    resource_name: z.string().nullable().openapi({
      description: "Resource name recorded in the event snapshot, or null when not recorded.",
    }),
    result: z.string(),
    trace_id: z.string().nullable(),
    correlation_id: z.string().nullable(),
    ip: z.string().nullable(),
    user_agent: z.string().nullable(),
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
    reason: z.string().nullable(),
    reason_redacted: z.boolean(),
    details: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .openapi({
        description:
          "Safe recorded facts of this action (versions, environment, validity, operation); never contents.",
      }),
    metadata: z.record(z.string(), z.unknown()),
  })
  .openapi("AuditEntry");

const ListResponse = paginatedResponse(AuditEntrySchema, "AuditLogListResponse");

const FilterQuery = z
  .object({
    action: z.string().optional(),
    actor_id: z.string().uuid().optional(),
    actor_type: z.enum(["user", "system_account", "system", "unknown"]).optional(),
    api_key_id: z.string().uuid().optional().openapi({
      description:
        "Matches verified use or historical recorded metadata; inspect the returned field to distinguish provenance.",
    }),
    session_id: z.string().uuid().optional().openapi({
      description:
        "Matches verified use or historical recorded metadata; inspect the returned field to distinguish provenance.",
    }),
    access_type: z
      .enum([
        "api_key",
        "browser_session",
        "mcp_oauth",
        "token_exchange",
        "external_bearer",
        "task_run",
        "portal_token",
        "device_runner",
      ])
      .optional(),
    oauth_client_id: z
      .string()
      .max(128)
      .regex(/^[a-zA-Z0-9._:-]+$/)
      .optional(),
    request_source: RequestSourceSchema.optional(),
    origin_source: RequestSourceSchema.optional(),
    execution_source: RequestSourceSchema.optional(),
    execution_id: z.string().uuid().optional(),
    conversation_id: z.string().uuid().optional(),
    workflow_id: z.string().uuid().optional(),
    task_id: z.string().uuid().optional().openapi({
      description: "Everything recorded about one task: its own entries and its runs and grants.",
    }),
    task_run_id: z.string().uuid().optional().openapi({
      description: "Everything recorded about one run of a task.",
    }),
    resource_type: z.string().optional(),
    resource_types: z.string().max(2000).optional(),
    resource_id: z.string().optional(),
    result: z.enum(["success", "denied", "error"]).optional(),
    trace_id: z.string().optional(),
    correlation_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
    ts_from: z.string().datetime().optional(),
    ts_to: z.string().datetime().optional().openapi({
      description: "Exclusive UTC upper bound. Events at this instant are excluded.",
    }),
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

const resourceSearchRoute = createRoute({
  method: "get",
  path: "/v1/audit-log/resources",
  tags: ["audit"],
  summary: "Find resources by recorded audit names or stable ID",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      search: z.string().trim().min(2).max(100),
      resource_type: z.string().min(1).max(100).optional(),
      limit: z.coerce.number().int().positive().max(30).optional(),
    }),
  },
  responses: {
    200: {
      description: "Matching recorded resource names and IDs",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(
              z.object({
                resource_type: z.string(),
                resource_id: z.string(),
                resource_name: z.string().nullable(),
                last_seen_at: z.string().datetime(),
              }),
            ),
          }),
        },
      },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
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
  api_key_id?: string | undefined;
  session_id?: string | undefined;
  access_type?:
    | "api_key"
    | "browser_session"
    | "mcp_oauth"
    | "token_exchange"
    | "external_bearer"
    | "task_run"
    | "portal_token"
    | "device_runner"
    | undefined;
  oauth_client_id?: string | undefined;
  request_source?: z.infer<typeof RequestSourceSchema> | undefined;
  origin_source?: z.infer<typeof RequestSourceSchema> | undefined;
  execution_source?: z.infer<typeof RequestSourceSchema> | undefined;
  execution_id?: string | undefined;
  conversation_id?: string | undefined;
  workflow_id?: string | undefined;
  task_id?: string | undefined;
  task_run_id?: string | undefined;
  resource_type?: string | undefined;
  resource_types?: string | undefined;
  resource_id?: string | undefined;
  result?: "success" | "denied" | "error" | undefined;
  trace_id?: string | undefined;
  correlation_id?: string | undefined;
  ts_from?: string | undefined;
  ts_to?: string | undefined;
}

function filtersFromQuery(tenant_id: string, q: RawFilterQuery): AuditQueryFilters {
  const f: AuditQueryFilters = { tenant_id };
  const actions = parseActions(q.action);
  if (actions) f.actions = actions;
  if (q.actor_id) f.actor_id = q.actor_id;
  if (q.actor_type) f.actor_type = q.actor_type as AuditActorType;
  if (q.api_key_id) f.api_key_id = q.api_key_id;
  if (q.session_id) f.session_id = q.session_id;
  if (q.access_type) f.access_type = q.access_type;
  if (q.oauth_client_id) f.oauth_client_id = q.oauth_client_id;
  if (q.request_source) f.request_source = q.request_source;
  if (q.origin_source) f.origin_source = q.origin_source;
  if (q.execution_source) f.execution_source = q.execution_source;
  if (q.execution_id) f.execution_id = q.execution_id;
  if (q.conversation_id) f.conversation_id = q.conversation_id;
  if (q.workflow_id) f.workflow_id = q.workflow_id;
  if (q.task_id) f.task_id = q.task_id;
  if (q.task_run_id) f.task_run_id = q.task_run_id;
  if (q.resource_type) f.resource_type = q.resource_type;
  const resourceTypes = parseActions(q.resource_types);
  if (resourceTypes) f.resource_types = resourceTypes;
  if (q.resource_id) f.resource_id = q.resource_id;
  if (q.result) f.result = q.result as AuditResult;
  if (q.trace_id) f.trace_id = q.trace_id;
  if (q.correlation_id) f.correlation_id = q.correlation_id;
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
    const parsed = FilterQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return validationFailedResponse(c, parsed.error.flatten());
    }
    const filters = filtersFromQuery(principal.tenant_id, parsed.data);
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

  app.openapi(resourceSearchRoute, async (c) => {
    const principal = requireAuth(c);
    const q = c.req.valid("query");
    const items = await searchAuditResources(
      c.get("db"),
      principal.tenant_id,
      q.search,
      q.resource_type,
      q.limit,
    );
    return c.json({ items }, 200);
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
