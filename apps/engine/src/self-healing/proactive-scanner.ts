import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { AuditActorType } from "../audit/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { schemaVersions } from "../db/schema/connectors.ts";
import { executions } from "../db/schema/executions.ts";
import { tenants } from "../db/schema/identity.ts";
import { workflows, workflowVersions } from "../db/schema/workflows.ts";
import { logger } from "../logging/index.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import { diffShapesDeep } from "../schema-versions/index.ts";
import { hasFieldLevelChange } from "./drift-detector.ts";
import type { SignalSource } from "./service.ts";
import { scanStdlibDrift } from "./stdlib-drift-scan.ts";
import type { DriftSignal, SchemaShape } from "./types.ts";

export interface ProactiveScanFilters {
  tenant_id?: string;
  workflow_id?: string;
  connector_id?: string;
}

export interface ScannedSignalContext {
  tenant_id: string;
  workflow_id: string;
  execution_id: null;
  step_id: null;
  workflow_step_id?: string | null;
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

export function driftSignalContext(
  ctx: ScannedSignalContext,
  extra: {
    actor_id: string | null;
    actor_type: AuditActorType;
    source: SignalSource;
    scan_id: string;
  },
): {
  tenant_id: string;
  workflow_id: string;
  execution_id: null;
  step_id: null;
  workflow_step_id?: string;
  connector_id?: string;
  endpoint_key?: string;
  actor_id: string | null;
  actor_type: AuditActorType;
  source: SignalSource;
  scan_id: string;
  repair_input: ScannedSignalContext["repair_input"];
} {
  return {
    tenant_id: ctx.tenant_id,
    workflow_id: ctx.workflow_id,
    execution_id: ctx.execution_id,
    step_id: ctx.step_id,
    ...(ctx.workflow_step_id ? { workflow_step_id: ctx.workflow_step_id } : {}),
    ...(ctx.connector_id ? { connector_id: ctx.connector_id } : {}),
    ...(ctx.endpoint_key ? { endpoint_key: ctx.endpoint_key } : {}),
    actor_id: extra.actor_id,
    actor_type: extra.actor_type,
    source: extra.source,
    scan_id: extra.scan_id,
    repair_input: ctx.repair_input,
  };
}

export interface UnanchoredDrift {
  signal: DriftSignal;
  reason: "hook_surface_not_supported" | "no_workflow_anchor";
  resource_id: string;
}

export interface ScanResult {
  signals: ScannedSignal[];
  unanchored: UnanchoredDrift[];
}

function tokenisedAnchor(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(":");
}

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
    if (bucket.length < 2) continue;
    const [after, before] = bucket;
    if (!after || !before) continue;
    const diff = diffShapesDeep(before.schema, after.schema);
    if (diff.widened.length === 0) continue;
    if (before.schema.type === "unknown" || after.schema.type === "unknown") {
      logger.info({
        module: "self-healing",
        action: "proactive_scan.uninformative_drift",
        msg: "response shape collapsed to unknown — no field-level change to repair",
        tenant_id,
        workflow_id,
        connector_id,
        endpoint_key,
        step_id,
        direction: after.schema.type === "unknown" ? "collapsed" : "recovered",
      });
      continue;
    }
    if (!hasFieldLevelChange(before.schema, after.schema)) {
      logger.info({
        module: "self-healing",
        action: "proactive_scan.no_field_change",
        msg: "skipped: no field-level change",
        tenant_id,
        workflow_id,
        connector_id,
        endpoint_key,
        step_id,
        widened: diff.widened.slice(0, 20),
      });
      continue;
    }

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
        workflow_step_id: step_id,
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
