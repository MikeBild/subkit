import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import {
  getScan,
  listScans,
  runAdminScan,
  type ScanOutcome,
  type SelfHealingScanRow,
} from "../../self-healing/admin-scans.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, reject } from "./index.ts";

const TAGS = ["self-healing"] as const;

const ScanRequestBody = z
  .object({
    workflow_id: z.string().uuid().optional(),
    connector_id: z.string().uuid().optional(),
  })
  .openapi("SelfHealingScanRequest");

const ScanHeaders = z.object({
  "idempotency-key": z.string().min(8).max(128).optional(),
});

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

type ScanBody = z.infer<typeof ScanRequestBody>;
type ListInput = z.infer<typeof ListQuery>;
type AdminScanOutcome = Exclude<ScanOutcome, { kind: "not_persisted" }>;

interface ScanInput {
  readonly body: ScanBody;
  readonly idempotency_key: string | null;
}

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

function scanBody(outcome: AdminScanOutcome) {
  if (outcome.kind === "replay") {
    const hit = outcome.scan;
    return {
      scan_id: hit.id,
      signals_detected: hit.signals_detected,
      candidates_created: hit.candidates_created,
      unanchored_detected: hit.unanchored_detected,
      duration_ms: hit.duration_ms ?? 0,
      candidates: [],
      unanchored: [],
      idempotent_replay: true,
    };
  }
  const result = outcome.result;
  return {
    scan_id: result.scan_id,
    signals_detected: result.signals_detected,
    candidates_created: result.candidates_created,
    unanchored_detected: result.unanchored_detected,
    duration_ms: result.duration_ms,
    candidates: result.candidates,
    unanchored: result.unanchored,
  };
}

export const runSelfHealingScanOperation = defineOperation<ScanInput, AdminScanOutcome>({
  id: "self_healing.scan.run",
  summary: "Trigger a proactive drift scan",
  permission: "self_healing:write",
  effect: "write",
  audit: AuditAction.SELF_HEALING_SCAN_TRIGGERED,
  async handler(scope, { body, idempotency_key }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    return runAdminScan(scope.db, principal, {
      workflow_id: body.workflow_id,
      connector_id: body.connector_id,
      idempotency_key,
    });
  },
  http: {
    method: "post",
    path: "/v1/self-healing/scans",
    tags: TAGS,
    headers: ScanHeaders,
    body: ScanRequestBody,
    response: ScanResponse,
    success: [
      { status: 200, description: "Scan complete" },
      { status: 202, description: "Idempotent replay — returning prior scan result" },
    ],
    statusFor: (outcome) => (outcome.kind === "replay" ? 202 : 200),
    errors: { 403: "Admin role required" },
    toInput: ({ json, header }) => ({
      body: json as ScanBody,
      idempotency_key: (header as { "idempotency-key"?: string })["idempotency-key"] ?? null,
    }),
    toBody: scanBody,
  },
});

export const listSelfHealingScansOperation = defineOperation<ListInput, SelfHealingScanRow[]>({
  id: "self_healing.scan.list",
  summary: "List proactive drift scans",
  permission: "self_healing:read",
  effect: "read",
  handler: (scope, query) =>
    listScans(scope.db, scope.tenant_id, {
      status: query.status,
      source: query.source,
      limit: query.limit ?? 50,
    }),
  http: {
    method: "get",
    path: "/v1/self-healing/scans",
    tags: TAGS,
    query: ListQuery,
    response: ListResponse,
    errors: { 403: "Forbidden" },
    toInput: ({ query }) => query as ListInput,
    toBody: (rows) => ({ items: rows.map(serializeScanRow) }),
  },
});

export const getSelfHealingScanOperation = defineOperation<string, SelfHealingScanRow>({
  id: "self_healing.scan.get",
  summary: "Fetch a proactive drift scan",
  permission: "self_healing:read",
  effect: "read",
  async handler(scope, id) {
    return (await getScan(scope.db, scope.tenant_id, id)) ?? reject.notFound("self_healing_scan");
  },
  http: {
    method: "get",
    path: "/v1/self-healing/scans/{id}",
    tags: TAGS,
    params: IdParam,
    response: ScanRecordSchema,
    errors: { 403: "Forbidden", 404: "Not found" },
    toInput: ({ param }) => (param as { id: string }).id,
    toBody: serializeScanRow,
  },
});
