import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import {
  getScan,
  listScans,
  runAdminScan,
  type SelfHealingScanRow,
} from "../../self-healing/index.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const ScanRequestBody = z
  .object({
    workflow_id: z.string().uuid().optional(),
    connector_id: z.string().uuid().optional(),
  })
  .openapi("SelfHealingScanRequest");

const SignalTypeEnum = z.enum([
  "stdlib_version_drift",
  "schema_diff",
  "validation_failed",
  "jsonata_path_miss",
  "http_status_new_shape",
  "endpoint_contract",
  "gate_block",
]);

const ScanCandidateSchema = z
  .object({
    id: z.string().uuid(),
    signal_type: SignalTypeEnum,
    classification: z.enum(["safe", "unsafe"]),
    status: z.enum(["proposed", "applied", "rejected", "superseded", "inapplicable"]),
  })
  .openapi("SelfHealingScanCandidate");

const UnanchoredEntry = z
  .object({
    signal_type: SignalTypeEnum,
    reason: z.enum(["hook_surface_not_supported", "no_workflow_anchor"]),
    resource_id: z.string(),
  })
  .openapi("SelfHealingScanUnanchored");

const ScanResponse = z
  .object({
    scan_id: z.string().uuid(),
    signals_detected: z.number().int(),
    candidates_created: z.number().int(),
    unanchored_detected: z.number().int(),
    duration_ms: z.number().int(),
    candidates: z.array(ScanCandidateSchema),
    unanchored: z.array(UnanchoredEntry),
    idempotent_replay: z.boolean().optional(),
  })
  .openapi("SelfHealingScanResponse");

const ScanRecordSchema = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    source: z.string(),
    filters: z.unknown(),
    actor_id: z.string().uuid().nullable(),
    idempotency_key: z.string().nullable(),
    signals_detected: z.number().int(),
    candidates_created: z.number().int(),
    unanchored_detected: z.number().int(),
    duration_ms: z.number().int().nullable(),
    status: z.string(),
    error: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("SelfHealingScanRecord");

const ListResponse = z
  .object({ items: z.array(ScanRecordSchema) })
  .openapi("SelfHealingScanListResponse");

const ListQuery = z
  .object({
    status: z.enum(["running", "succeeded", "failed"]).optional(),
    source: z.enum(["scheduler", "admin_http", "mcp"]).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .openapi("ListSelfHealingScansQuery");

function serializeScanRow(row: SelfHealingScanRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    source: row.source,
    filters: row.filters,
    actor_id: row.actor_id ?? null,
    idempotency_key: row.idempotency_key ?? null,
    signals_detected: row.signals_detected,
    candidates_created: row.candidates_created,
    unanchored_detected: row.unanchored_detected,
    duration_ms: row.duration_ms ?? null,
    status: row.status,
    error: row.error ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

const scanRoute = createRoute({
  method: "post",
  path: "/v1/self-healing/scans",
  tags: ["self-healing"],
  summary: "Trigger a proactive drift scan",
  security: [{ bearerAuth: [] }],
  request: {
    headers: z.object({
      "idempotency-key": z.string().min(8).max(128).optional(),
    }),
    body: { content: { "application/json": { schema: ScanRequestBody } } },
  },
  responses: {
    200: {
      description: "Scan complete",
      content: { "application/json": { schema: ScanResponse } },
    },
    202: {
      description: "Idempotent replay — returning prior scan result",
      content: { "application/json": { schema: ScanResponse } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/v1/self-healing/scans",
  tags: ["self-healing"],
  summary: "List proactive drift scans",
  security: [{ bearerAuth: [] }],
  request: { query: ListQuery },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ListResponse } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getRouteSpec = createRoute({
  method: "get",
  path: "/v1/self-healing/scans/{id}",
  tags: ["self-healing"],
  summary: "Fetch a proactive drift scan",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ScanRecordSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerSelfHealingRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/self-healing/scans", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("self_healing:write")(c, next);
    return requirePermission("self_healing:read")(c, next);
  });
  app.use("/v1/self-healing/scans/:id", requirePermission("self_healing:read"));

  app.openapi(scanRoute, async (c) => {
    const principal = requireAuth(c);
    const body = c.req.valid("json");
    const outcome = await runAdminScan(c.get("db"), principal, {
      workflow_id: body.workflow_id,
      connector_id: body.connector_id,
      idempotency_key: c.req.header("idempotency-key") ?? null,
    });
    if (outcome.kind === "replay") {
      const hit = outcome.scan;
      return c.json(
        {
          scan_id: hit.id,
          signals_detected: hit.signals_detected,
          candidates_created: hit.candidates_created,
          unanchored_detected: hit.unanchored_detected,
          duration_ms: hit.duration_ms ?? 0,
          candidates: [],
          unanchored: [],
          idempotent_replay: true,
        },
        202,
      );
    }
    const result = outcome.result;
    return c.json(
      {
        scan_id: result.scan_id,
        signals_detected: result.signals_detected,
        candidates_created: result.candidates_created,
        unanchored_detected: result.unanchored_detected,
        duration_ms: result.duration_ms,
        candidates: result.candidates,
        unanchored: result.unanchored,
      },
      200,
    );
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const q = c.req.valid("query");
    const rows = await listScans(c.get("db"), principal.tenant_id, {
      status: q.status,
      source: q.source,
      limit: q.limit ?? 50,
    });
    return c.json({ items: rows.map(serializeScanRow) }, 200);
  });

  app.openapi(getRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const row = await getScan(c.get("db"), principal.tenant_id, id);
    if (!row) throw new NotFoundError("self_healing_scan");
    return c.json(serializeScanRow(row), 200);
  });
}
