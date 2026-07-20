// Proactive drift scanner — finds drift between runs, not at the
// moment a customer-facing execution fails.
//
// Three pure DB scanners feed a single `scanForDrift` orchestrator:
//
//   * `scanStdlibVersionDrift`  — reuses `stdlib-drift-scan.ts`. Emits
//     `stdlib_version_drift` signals for workflows + request hooks
//     whose recorded sk-stdlib major differs from the engine's.
//
//   * `scanSchemaShapeDrift`    — compares accumulated observations per
//     `(tenant, connector, endpoint, workflow, step)`. Incompatible
//     type changes emit `schema_diff`; additive fields remain evidence.
//
//   * `scanValidationDrift`     — walks every workflow whose current
//     version's `dag.validation_expression` is non-empty. If the
//     latest execution on the current version failed AND an earlier
//     execution on the SAME version succeeded, the invariant has
//     started failing on previously-valid output. We emit a
//     `validation_failed` signal so the operator gets a Patch
//     Candidate before the next downstream chain wedges on the
//     same envelope.
//
// All three scanners are pure: DB reads only, no LLM, no network.
// `scanForDrift` returns a flat list of `{ signal, ctx }`; the caller
// (scheduler reconciler / admin route / MCP tool) is responsible for
// running each through `processDriftSignal(..., { allowAutoApply: false })`
// to persist Patch Candidates.

import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db, Executor } from "../db/client.ts";
import { schemaVersions } from "../db/schema/connectors.ts";
import { executions } from "../db/schema/executions.ts";
import { tenants } from "../db/schema/identity.ts";
import { workflows, workflowVersions } from "../db/schema/workflows.ts";
import { logger } from "../logging/logger.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import { diffShapesDeep } from "../schema-versions/service.ts";
import { scanStdlibDrift } from "./stdlib-drift-scan.ts";
import type { DriftSignal, SchemaShape } from "./types.ts";

export interface ProactiveScanFilters {
  /** Limit the scan to a single tenant. Required for tenant-scoped
   *  callers (admin HTTP). Omit to fan out across all live tenants
   *  (the scheduler does this implicitly per-tenant, so it always
   *  passes the tenant_id). */
  tenant_id?: string;
  /** Limit validation and schema-drift scanning to a single workflow. */
  workflow_id?: string;
  /** Limit schema-drift scanning to a single connector. Stdlib +
   *  validation drift scanners ignore this filter. */
  connector_id?: string;
}

/**
 * Carrier the scanner attaches to every emitted signal. The HTTP /
 * scheduler / MCP orchestrators receive a `ScannedSignal[]` and call
 * `processDriftSignal(signal, fullCtx, ...)` where `fullCtx` is this
 * partial context layered with `source`, `actor_id`, and `scan_id`.
 *
 * `repair_input.failing_step_id` is a synthetic token like
 * `proactive:schema_diff:<connector_id>:<endpoint_key>` so the LLM
 * prompt has a stable handle but downstream code can immediately
 * tell it never came from a real execution_steps row.
 */
export interface ScannedSignalContext {
  tenant_id: string;
  workflow_id: string;
  execution_id: null;
  step_id: null;
  connector_id?: string;
  endpoint_key?: string;
  repair_input: {
    failing_step_id: string;
    request?: unknown;
    response?: unknown;
  };
}

export interface ScannedSignal {
  signal: DriftSignal;
  ctx: ScannedSignalContext;
}

/**
 * Drift the scanner found but cannot promote to a Patch Candidate
 * (which is workflow-scoped at the DB level). Surfaced to the
 * operator so the drift is visible even when no workflow anchor
 * exists:
 *
 *   * `hook_surface_not_supported` — stdlib version drift on a
 *     `request_hooks` row. Hooks are tenant-scoped, not workflow-
 *     scoped, so they have no Patch Candidate anchor today.
 *   * `no_workflow_anchor` — schema-shape drift on a (connector,
 *     endpoint) pair that no workflow in the tenant references.
 *
 * Operators read these from the scan response (HTTP / MCP), the
 * audit metadata, and the `proactive_drift_unanchored_total`
 * metric.
 */
export interface UnanchoredDrift {
  signal: DriftSignal;
  reason: "hook_surface_not_supported" | "no_workflow_anchor";
  resource_id: string;
}

/**
 * The scanner's pure output. The orchestrator-side scan_id is owned
 * by the caller (it comes from the `self_healing_scans` row INSERT,
 * not from the scanner itself) — we deliberately do NOT generate one
 * here because emitting a uuid that nobody reads would be confusing
 * forensic noise.
 */
export interface ScanResult {
  signals: ScannedSignal[];
  unanchored: UnanchoredDrift[];
}

function tokenisedAnchor(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(":");
}

/**
 * Stdlib version drift — wraps the existing tenant-scoped scanner
 * and tags each emitted signal with a workflow / request-hook
 * carrier. `stdlib_version_drift` signals attach to whatever surface
 * recorded the version (a workflow row or a request_hook row).
 *
 * Hook-surface drift can't be promoted to a Patch Candidate today
 * because `patch_candidates.workflow_id` is NOT NULL — hooks are
 * tenant-scoped, not workflow-scoped. We return those signals in
 * the `unanchored` bucket instead so the operator still sees them
 * in the scan response and can take manual action.
 */
async function scanStdlibVersionDriftForTenant(
  tenant_id: string,
  exec: Executor,
): Promise<{ anchored: ScannedSignal[]; unanchored: UnanchoredDrift[] }> {
  const signals = await scanStdlibDrift(tenant_id, exec);
  const anchored: ScannedSignal[] = [];
  const unanchored: UnanchoredDrift[] = [];
  for (const signal of signals) {
    if (signal.kind !== "stdlib_version_drift") continue;
    if (signal.surface !== "workflow") {
      unanchored.push({
        signal,
        reason: "hook_surface_not_supported",
        resource_id: signal.resource_id,
      });
      logger.info({
        module: "self-healing",
        action: "proactive_scan.unanchored",
        msg: "stdlib drift on request_hook surface — surfaced as unanchored",
        tenant_id,
        resource_id: signal.resource_id,
      });
      continue;
    }
    anchored.push({
      signal,
      ctx: {
        tenant_id,
        workflow_id: signal.resource_id,
        execution_id: null,
        step_id: null,
        repair_input: {
          failing_step_id: tokenisedAnchor(["proactive", "stdlib", signal.resource_id]),
        },
      },
    });
  }
  return { anchored, unanchored };
}

/**
 * Schema shape drift compares observations only within their recorded
 * workflow and step provenance. Additive evidence is compatible;
 * incompatible type changes are the proactive patch signal.
 */
async function scanSchemaShapeDriftForTenant(
  tenant_id: string,
  exec: Executor,
  filters: { connector_id?: string; workflow_id?: string },
): Promise<{ anchored: ScannedSignal[]; unanchored: UnanchoredDrift[] }> {
  const conditions = [isNotNull(schemaVersions.workflow_id), isNotNull(schemaVersions.step_id)];
  if (filters.connector_id) {
    conditions.push(eq(schemaVersions.connector_id, filters.connector_id));
  }
  if (filters.workflow_id) {
    conditions.push(eq(schemaVersions.workflow_id, filters.workflow_id));
  }
  const rows = await exec
    .select({
      connector_id: schemaVersions.connector_id,
      endpoint_key: schemaVersions.endpoint_key,
      workflow_id: schemaVersions.workflow_id,
      step_id: schemaVersions.step_id,
      schema: schemaVersions.schema,
      seen_at: schemaVersions.seen_at,
    })
    .from(schemaVersions)
    .where(and(eq(schemaVersions.tenant_id, tenant_id), ...conditions))
    .orderBy(desc(schemaVersions.seen_at));

  interface GroupEntry {
    connector_id: string;
    endpoint_key: string;
    workflow_id: string;
    step_id: string;
    rows: Array<{ schema: SchemaShape; seen_at: Date }>;
  }
  const grouped = new Map<string, GroupEntry>();
  for (const row of rows) {
    if (!row.workflow_id || !row.step_id) continue;
    const key = JSON.stringify([row.connector_id, row.endpoint_key, row.workflow_id, row.step_id]);
    const existing = grouped.get(key);
    if (existing) {
      if (existing.rows.length >= 2) continue;
      existing.rows.push({ schema: row.schema as SchemaShape, seen_at: row.seen_at });
    } else {
      grouped.set(key, {
        connector_id: row.connector_id,
        endpoint_key: row.endpoint_key,
        workflow_id: row.workflow_id,
        step_id: row.step_id,
        rows: [{ schema: row.schema as SchemaShape, seen_at: row.seen_at }],
      });
    }
  }

  if (grouped.size === 0) return { anchored: [], unanchored: [] };

  const workflowRows = await exec
    .select({ id: workflows.id, dag: workflowVersions.dag })
    .from(workflows)
    .innerJoin(workflowVersions, eq(workflows.current_version_id, workflowVersions.id))
    .where(and(eq(workflows.tenant_id, tenant_id), isNull(workflows.deleted_at)));
  const activeWorkflows = new Map(
    workflowRows.map((row) => [row.id, extractWorkflowStepIds(row.dag)]),
  );

  const anchored: ScannedSignal[] = [];
  const unanchored: UnanchoredDrift[] = [];
  for (const {
    connector_id,
    endpoint_key,
    workflow_id,
    step_id,
    rows: bucket,
  } of grouped.values()) {
    if (bucket.length < 2) continue; // Need before AND after to diff.
    const [after, before] = bucket; // desc order: index 0 newest
    if (!after || !before) continue;
    const diff = diffShapesDeep(before.schema, after.schema);
    if (diff.widened.length === 0) continue;

    const signal: DriftSignal = {
      kind: "schema_diff",
      before: before.schema,
      after: after.schema,
      added: diff.added,
      removed: diff.removed,
      widened: diff.widened,
    };
    if (!activeWorkflows.get(workflow_id)?.has(step_id)) {
      unanchored.push({ signal, reason: "no_workflow_anchor", resource_id: workflow_id });
      logger.info({
        module: "self-healing",
        action: "proactive_scan.unanchored",
        msg: "schema drift provenance references no active workflow",
        tenant_id,
        workflow_id,
        connector_id,
        endpoint_key,
        step_id,
      });
      continue;
    }
    anchored.push({
      signal,
      ctx: {
        tenant_id,
        workflow_id,
        execution_id: null,
        step_id: null,
        connector_id,
        endpoint_key,
        repair_input: {
          failing_step_id: tokenisedAnchor([
            "proactive",
            "schema_diff",
            connector_id,
            endpoint_key,
            workflow_id,
            step_id,
          ]),
          // The "response" we hand the LLM is the newer shape — the
          // model uses it to ground the patch (rename / type-widen
          // suggestions stay tied to the observed structure).
          response: after.schema,
        },
      },
    });
  }
  return { anchored, unanchored };
}

function extractWorkflowStepIds(dag: unknown): Set<string> {
  const stepIds = new Set<string>();
  const stack: unknown[] = [dag];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    const object = value as Record<string, unknown>;
    if (typeof object.id === "string" && typeof object.kind === "string") {
      stepIds.add(object.id);
    }
    stack.push(...Object.values(object));
  }
  return stepIds;
}

function readValidationExpression(dag: unknown): string | null {
  if (!dag || typeof dag !== "object" || Array.isArray(dag)) return null;
  const v = (dag as Record<string, unknown>).validation_expression;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Validation expression drift — workflows whose current version has
 * a non-empty `validation_expression` AND whose latest execution on
 * the current version failed AND an earlier execution on the same
 * version succeeded. The pair "previously succeeded, now failing"
 * is the actual drift signal: the expression itself didn't change,
 * but the upstream payload now violates the invariant.
 *
 * We don't read offloaded result envelopes to confirm the failure
 * was specifically `validation_failed` — that would require a heavy
 * scan and the reactive path is already wired for that case. The
 * proactive trigger fires whenever an execution failed AFTER a
 * prior success on the same version, and lets the LLM propose a
 * patch grounded on the current invariant text.
 */
async function scanValidationDriftForTenant(
  tenant_id: string,
  exec: Executor,
  filters: { workflow_id?: string },
): Promise<{ anchored: ScannedSignal[]; unanchored: UnanchoredDrift[] }> {
  const wfRows = await exec
    .select({
      workflow_id: workflows.id,
      version_id: workflowVersions.id,
      dag: workflowVersions.dag,
    })
    .from(workflows)
    .innerJoin(workflowVersions, eq(workflows.current_version_id, workflowVersions.id))
    .where(
      filters.workflow_id
        ? and(
            eq(workflows.tenant_id, tenant_id),
            isNull(workflows.deleted_at),
            eq(workflows.id, filters.workflow_id),
          )
        : and(eq(workflows.tenant_id, tenant_id), isNull(workflows.deleted_at)),
    );

  const anchored: ScannedSignal[] = [];
  for (const row of wfRows) {
    const expression = readValidationExpression(row.dag);
    if (!expression) continue;

    const execRows = await exec
      .select({
        id: executions.id,
        status: executions.status,
        started_at: executions.started_at,
      })
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, tenant_id),
          eq(executions.workflow_version_id, row.version_id),
          isNotNull(executions.started_at),
        ),
      )
      .orderBy(desc(executions.started_at))
      .limit(20);

    if (execRows.length < 2) continue;
    const newest = execRows[0];
    if (newest?.status !== "failed") continue;
    const priorSucceeded = execRows.slice(1).some((e) => e.status === "succeeded");
    if (!priorSucceeded) continue;

    const signal: DriftSignal = {
      kind: "validation_failed",
      expression,
      // Without parsing the offloaded result envelope we cannot
      // surface the exact `actual_value` that tripped the invariant.
      // The repair flow gets the expression text and the proactive
      // anchor — the operator's review captures whether the proposal
      // is right before any apply.
      actual_value: null,
    };
    anchored.push({
      signal,
      ctx: {
        tenant_id,
        workflow_id: row.workflow_id,
        execution_id: null,
        step_id: null,
        repair_input: {
          failing_step_id: tokenisedAnchor(["proactive", "validation", row.workflow_id]),
        },
      },
    });
  }
  return { anchored, unanchored: [] };
}

/**
 * Orchestrator — runs all three scanners and returns the flattened
 * anchored + unanchored signal lists. The caller (scheduler runner,
 * HTTP route, MCP tool) owns the scan_id (it comes from the
 * `self_healing_scans` row INSERT) and uses it when stamping the
 * downstream Patch Candidate diff + the SELF_HEALING_SCAN_*
 * audit rows.
 *
 * When `filters.tenant_id` is omitted, the scanner fans out across
 * every live tenant. The scheduler reconciler always passes a
 * specific tenant_id (the one it just CAS-stamped), so the fan-out
 * branch is exercised by the admin HTTP "scan everything" form.
 */
export async function scanForDrift(filters: ProactiveScanFilters, exec: Db): Promise<ScanResult> {
  return instrument({
    module: "self-healing",
    action: "scan_for_drift",
    memory: true,
    fields: {
      ...(filters.tenant_id ? { scoped_tenant: true } : { scoped_tenant: false }),
    },
    fn: () => scanForDriftImpl(filters, exec),
  });
}

async function scanForDriftImpl(filters: ProactiveScanFilters, exec: Db): Promise<ScanResult> {
  const tenantIds: string[] = [];
  if (filters.tenant_id) {
    tenantIds.push(filters.tenant_id);
  } else {
    // tenant-filter:exempt — proactive scan sweeps every live tenant
    const rows = await exec
      .select({ id: tenants.id })
      .from(tenants)
      .where(isNull(tenants.deleted_at));
    for (const row of rows) tenantIds.push(row.id);
  }

  const anchored: ScannedSignal[] = [];
  const unanchored: UnanchoredDrift[] = [];
  for (const tenant_id of tenantIds) {
    try {
      const [stdlib, schema, validation] = await Promise.all([
        scanStdlibVersionDriftForTenant(tenant_id, exec),
        scanSchemaShapeDriftForTenant(tenant_id, exec, {
          ...(filters.connector_id ? { connector_id: filters.connector_id } : {}),
          ...(filters.workflow_id ? { workflow_id: filters.workflow_id } : {}),
        }),
        scanValidationDriftForTenant(tenant_id, exec, {
          ...(filters.workflow_id ? { workflow_id: filters.workflow_id } : {}),
        }),
      ]);
      anchored.push(...stdlib.anchored, ...schema.anchored, ...validation.anchored);
      unanchored.push(...stdlib.unanchored, ...schema.unanchored, ...validation.unanchored);
    } catch (err) {
      logger.error({
        module: "self-healing",
        action: "proactive_scan.tenant_failed",
        msg: "proactive drift scan failed for tenant — continuing with remaining tenants",
        tenant_id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    signals: anchored,
    unanchored,
  };
}
