// Admin-only self-healing HTTP surface.
//
// Routes:
//   POST   /v1/self-healing/scans          — trigger a proactive drift scan
//   GET    /v1/self-healing/scans          — list past scans
//   GET    /v1/self-healing/scans/{id}     — fetch one scan
//
// The POST endpoint is admin-gated because triggering a scan can
// produce LLM repair calls (proposing patches) and writes Patch
// Candidate rows. The list / read routes are also admin-gated to
// keep the operator surface consistent — proposed candidates are
// already reachable via the existing patch-candidates routes for
// reviewers.
//
// Proactive scans NEVER auto-apply. The route hard-wires
// `allowAutoApply: false` into every `processDriftSignal` call so a
// classification='safe' candidate with a passing fixture dry-run
// still lands in `status='proposed'` and waits for operator review
// via POST /v1/patch-candidates/{id}/approve.
//
// `Idempotency-Key` header (RFC draft "Idempotency-Key for HTTP"):
// when supplied, a replayed POST within 24h with the same key for
// the same tenant returns the persisted scan row's prior result
// with status 202 (Accepted, no work performed). The dedupe is
// backed by the unique index on (tenant_id, idempotency_key) in
// `self_healing_scans`.

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
import { processDriftSignal, type SignalSource, scanForDrift } from "../../self-healing/index.ts";
import { ForbiddenError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
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
]);

const ScanCandidateSchema = z
  .object({
    id: z.string().uuid(),
    signal_type: SignalTypeEnum,
    classification: z.enum(["safe", "unsafe"]),
    status: z.literal("proposed"),
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
    /** Count of drift signals the scanner could not anchor to a
     *  workflow (hook surfaces, orphan connectors). The detail
     *  list lives in `unanchored`; this count is also persisted on
     *  `self_healing_scans.unanchored_detected` so the count is
     *  available on idempotent replay even when the detail array
     *  is empty. */
    unanchored_detected: z.number().int(),
    duration_ms: z.number().int(),
    candidates: z.array(ScanCandidateSchema),
    /** Drift detected but not promoted to a Patch Candidate because
     *  no workflow anchor exists (hook surfaces, or connectors no
     *  workflow references). Empty on idempotent replay — the per-
     *  entry detail is not persisted on the scan row, only the
     *  count via `unanchored_detected`. */
    unanchored: z.array(UnanchoredEntry),
    /** True when the response was served from the idempotency cache;
     *  the candidates listed below are the ones the original scan
     *  produced — no additional work was performed. */
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

function ensureAdmin(roles: string[]): void {
  if (!roles.includes("admin")) {
    throw new ForbiddenError("admin_required");
  }
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
  app.openapi(scanRoute, async (c) => {
    const principal = requireAuth(c);
    ensureAdmin(principal.roles);
    const db = c.get("db");
    const body = c.req.valid("json");
    const idempotencyKey = c.req.header("idempotency-key") ?? null;

    // Tenant scoping comes from the authenticated principal, never
    // the request body. Admins cannot scan another tenant via this
    // endpoint — that's a privilege escalation surface we deliberately
    // do not expose. The scheduler reconciler is the only path that
    // fans out across tenants, and it runs as `actor_type: 'system'`
    // with no HTTP auth context.
    const filters = {
      tenant_id: principal.tenant_id,
      ...(body.workflow_id ? { workflow_id: body.workflow_id } : {}),
      ...(body.connector_id ? { connector_id: body.connector_id } : {}),
    };

    // Replay-cache lookup. If the same key was used in the last 24h
    // for the same tenant AND the prior scan reached a terminal
    // status, return that result without doing any work. A still-
    // `running` row (rare — only if a prior call crashed mid-scan)
    // is treated as no hit so the caller's retry runs a fresh scan.
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

    // Insert running record. The unique-index on
    // (tenant_id, idempotency_key) closes the SELECT-then-INSERT race
    // with a concurrent request that arrived between our cache lookup
    // and our insert: that request's INSERT wins, our INSERT goes to
    // no-op via ON CONFLICT, and we then re-read the winner's row and
    // return it as a (possibly still-running) replay. If the winner
    // is still in flight, we surface that to the caller as a 202 with
    // the running row's (zero) counters — the caller can poll
    // GET /v1/self-healing/scans/{id} for the final result.
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
      // INSERT was a no-op — concurrent caller already won this key.
      // Re-read and replay (including the still-running case).
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
      status: "proposed";
    }> = [];
    const unanchored: Array<{
      signal_type: z.infer<typeof SignalTypeEnum>;
      reason: "hook_surface_not_supported" | "no_workflow_anchor";
      resource_id: string;
    }> = [];

    try {
      // The TRIGGERED audit lives inside the try block so an audit-
      // insert failure flows into the same error-handling path that
      // finalises the scan row, rather than leaving an orphan
      // `status='running'` row visible via GET /v1/self-healing/scans.
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: "user",
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
            {
              tenant_id: ctx.tenant_id,
              workflow_id: ctx.workflow_id,
              execution_id: ctx.execution_id,
              step_id: ctx.step_id,
              ...(ctx.connector_id ? { connector_id: ctx.connector_id } : {}),
              ...(ctx.endpoint_key ? { endpoint_key: ctx.endpoint_key } : {}),
              actor_id: principal.id,
              source,
              scan_id,
              repair_input: ctx.repair_input,
            },
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
            // Forced to "proposed" — processDriftSignal never auto-
            // applies when allowAutoApply is false, so the literal
            // matches reality.
            status: "proposed",
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
        actor_type: "user",
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
    ensureAdmin(principal.roles);
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
    ensureAdmin(principal.roles);
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
