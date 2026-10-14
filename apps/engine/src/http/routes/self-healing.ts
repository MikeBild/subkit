import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import { selfHealingScans } from "../../db/schema/index.ts";
import { logger } from "../../logging/index.ts";
import {
  recordProactiveDriftCandidate,
  recordProactiveDriftScan,
  recordProactiveDriftSignal,
  recordProactiveDriftUnanchored,
} from "../../observability/index.ts";
import {
  driftSignalContext,
  processDriftSignal,
  type SignalSource,
  scanForDrift,
} from "../../self-healing/index.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const IDEMPOTENCY_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

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

function serializeScanRow(row: typeof selfHealingScans.$inferSelect) {
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
    const db = c.get("db");
    const body = c.req.valid("json");
    const idempotencyKey = c.req.header("idempotency-key") ?? null;

    const filters = {
      tenant_id: principal.tenant_id,
      ...(body.workflow_id ? { workflow_id: body.workflow_id } : {}),
      ...(body.connector_id ? { connector_id: body.connector_id } : {}),
    };

    async function findIdempotentHit(): Promise<typeof selfHealingScans.$inferSelect | undefined> {
      if (!idempotencyKey) return undefined;
      const cutoff = new Date(Date.now() - IDEMPOTENCY_REPLAY_WINDOW_MS);
      const cached = await db
        .select()
        .from(selfHealingScans)
        .where(
          and(
            eq(selfHealingScans.tenant_id, principal.tenant_id),
            eq(selfHealingScans.idempotency_key, idempotencyKey),
            gt(selfHealingScans.created_at, cutoff),
            inArray(selfHealingScans.status, ["succeeded", "failed"]),
          ),
        )
        .orderBy(desc(selfHealingScans.created_at))
        .limit(1);
      return cached[0];
    }

    function replayResponse(hit: typeof selfHealingScans.$inferSelect) {
      logger.info({
        module: "self-healing",
        action: "scan.idempotent_replay",
        msg: "returning prior scan result from idempotency cache",
        tenant_id: principal.tenant_id,
        scan_id: hit.id,
        idempotency_key: idempotencyKey,
      });
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

    const hit = await findIdempotentHit();
    if (hit) return replayResponse(hit);

    const started = new Date();
    const inserted = await db
      .insert(selfHealingScans)
      .values({
        tenant_id: principal.tenant_id,
        source: "admin_http",
        filters,
        actor_id: principal.id,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        status: "running",
      })
      .onConflictDoNothing({
        target: [selfHealingScans.tenant_id, selfHealingScans.idempotency_key],
      })
      .returning();
    const scanRow = inserted[0];
    if (!scanRow) {
      const concurrent = await db
        .select()
        .from(selfHealingScans)
        .where(
          and(
            eq(selfHealingScans.tenant_id, principal.tenant_id),
            eq(selfHealingScans.idempotency_key, idempotencyKey ?? ""),
          ),
        )
        .orderBy(desc(selfHealingScans.created_at))
        .limit(1);
      const winner = concurrent[0];
      if (!winner) {
        throw new Error("failed to persist self_healing_scans row");
      }
      return replayResponse(winner);
    }
    const scan_id = scanRow.id;

    let signals_detected = 0;
    let candidates_created = 0;
    let errorText: string | null = null;
    const candidates: Array<{
      id: string;
      signal_type: z.infer<typeof SignalTypeEnum>;
      classification: "safe" | "unsafe";
      status: "proposed" | "applied" | "rejected" | "superseded" | "inapplicable";
    }> = [];
    const unanchored: Array<{
      signal_type: z.infer<typeof SignalTypeEnum>;
      reason: "hook_surface_not_supported" | "no_workflow_anchor";
      resource_id: string;
    }> = [];

    try {
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.SELF_HEALING_SCAN_TRIGGERED,
          resource_type: "self_healing_scan",
          resource_id: scan_id,
          result: "success",
          metadata: { source: "admin_http", filters },
        },
        db,
      );
      const source: SignalSource = "proactive_admin";
      const scan = await scanForDrift(filters, db);
      signals_detected = scan.signals.length + scan.unanchored.length;

      for (const u of scan.unanchored) {
        unanchored.push({
          signal_type: u.signal.kind,
          reason: u.reason,
          resource_id: u.resource_id,
        });
        recordProactiveDriftUnanchored({
          tenant_id: principal.tenant_id,
          signal_type: u.signal.kind,
          reason: u.reason,
        });
      }

      for (const { signal, ctx } of scan.signals) {
        recordProactiveDriftSignal({
          tenant_id: principal.tenant_id,
          signal_type: signal.kind,
        });
        try {
          const result = await processDriftSignal(
            signal,
            driftSignalContext(ctx, {
              actor_id: principal.id,
              actor_type: principal.kind,
              source,
              scan_id,
            }),
            { allowAutoApply: false },
            db,
          );
          candidates_created += 1;
          recordProactiveDriftCandidate({
            tenant_id: principal.tenant_id,
            classification: result.classification,
          });
          candidates.push({
            id: result.candidate_id,
            signal_type: signal.kind,
            classification: result.classification,
            status: result.status,
          });
        } catch (err) {
          logger.error({
            module: "self-healing",
            action: "scan.signal_failed",
            msg: "failed to process drift signal — continuing",
            scan_id,
            tenant_id: principal.tenant_id,
            drift_kind: signal.kind,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      errorText = err instanceof Error ? err.message : String(err);
      logger.error({
        module: "self-healing",
        action: "scan.failed",
        msg: "admin-triggered scan failed mid-pass",
        scan_id,
        tenant_id: principal.tenant_id,
        err: errorText,
      });
    }

    const duration_ms = Date.now() - started.getTime();
    await db
      .update(selfHealingScans)
      .set({
        signals_detected,
        candidates_created,
        unanchored_detected: unanchored.length,
        duration_ms,
        status: errorText === null ? "succeeded" : "failed",
        error: errorText,
        updated_at: new Date(),
      })
      .where(eq(selfHealingScans.id, scan_id));

    recordProactiveDriftScan({
      tenant_id: principal.tenant_id,
      source: "admin_http",
      status: errorText === null ? "succeeded" : "failed",
      duration_ms,
    });

    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.SELF_HEALING_SCAN_COMPLETED,
        resource_type: "self_healing_scan",
        resource_id: scan_id,
        result: errorText === null ? "success" : "error",
        metadata: {
          source: "admin_http",
          signals_detected,
          candidates_created,
          unanchored_detected: unanchored.length,
          duration_ms,
          ...(errorText ? { error: errorText } : {}),
        },
      },
      db,
    );

    return c.json(
      {
        scan_id,
        signals_detected,
        candidates_created,
        unanchored_detected: unanchored.length,
        duration_ms,
        candidates,
        unanchored,
      },
      200,
    );
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const tenantPredicate = eq(selfHealingScans.tenant_id, principal.tenant_id);
    const extras = [];
    if (q.status) extras.push(eq(selfHealingScans.status, q.status));
    if (q.source) extras.push(eq(selfHealingScans.source, q.source));
    const rows = await db
      .select()
      .from(selfHealingScans)
      .where(extras.length > 0 ? and(tenantPredicate, ...extras) : tenantPredicate)
      .orderBy(desc(selfHealingScans.created_at))
      .limit(q.limit ?? 50);
    return c.json({ items: rows.map(serializeScanRow) }, 200);
  });

  app.openapi(getRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const rows = await db
      .select()
      .from(selfHealingScans)
      .where(and(eq(selfHealingScans.tenant_id, principal.tenant_id), eq(selfHealingScans.id, id)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError("self_healing_scan");
    return c.json(serializeScanRow(row), 200);
  });
}
