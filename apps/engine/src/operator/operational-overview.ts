import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { patchCandidates } from "../db/schema/index.ts";
import { getMetrics } from "../observability/index.ts";
import { readPatchReadinessBatch } from "../self-healing/index.ts";

export const OPERATIONAL_SCHEMA_VERSION = "operational-overview.v1" as const;
export const FAMILY_CONTRACT_VERSION = "2.1" as const;

export type ValueState = "observed" | "zero" | "missing" | "stale" | "forbidden";
export type Severity = "critical" | "urgent" | "healthy" | "information" | "unknown";
export type HealthState = "healthy" | "limited" | "critical" | "unknown";

export interface OperationalMetric {
  id: string;
  label: string;
  definition: string;
  relevance: string;
  kind: "count" | "ratio" | "duration" | "score" | "currency" | "state";
  value: number | null;
  value_state: ValueState;
  unit: "count" | "ratio" | "seconds" | "bytes" | "eur" | "state";
  severity: Severity;
  required: boolean;
  source_updated_at: string | null;
  expected_interval_seconds: number | null;
  stale_after_seconds: number | null;
  drilldown: { path: string; label_id: string };
  prometheus: { name: string; type: "gauge" | "counter" };
}

export interface OperationalOverview {
  schema_version: typeof OPERATIONAL_SCHEMA_VERSION;
  contract_version: typeof FAMILY_CONTRACT_VERSION;
  product: "subkit";
  generated_at: string;
  recommended_refresh_seconds: number;
  snapshot_state: "ready" | "partial" | "forbidden" | "contract-mismatch";
  core: {
    blocked: OperationalMetric;
    overdue: OperationalMetric;
    other_decisions: OperationalMetric;
    health: OperationalMetric & {
      state: HealthState;
      components: Array<{
        id: string;
        raw_value: number | null;
        unit: string;
        normalized_score: number | null;
        weight: number;
        contribution: number | null;
        freshness: "fresh" | "stale" | "missing" | "forbidden";
        required: boolean;
      }>;
    };
    data_freshness: OperationalMetric & {
      state: "fresh" | "stale" | "missing" | "forbidden";
      sources: Array<{
        id: string;
        updated_at: string | null;
        expected_interval_seconds: number;
        stale_after_seconds: number;
        state: "fresh" | "stale" | "missing" | "forbidden";
      }>;
    };
  };
  sections: Array<{
    id: string;
    title: string;
    visualization: "kpi" | "sparkline" | "time-series" | "progress" | "segmented-distribution";
    metrics: OperationalMetric[];
    drilldown: { path: string; label_id: string };
  }>;
  audit: {
    path: "/cockpit/audit";
    contract_version: typeof FAMILY_CONTRACT_VERSION;
    snapshot_generated_at: string;
  };
}

interface SnapshotRow extends Record<string, unknown> {
  blocked: string | number;
  overdue: string | number;
  other_decisions: string | number;
  active_workflows: string | number;
  execution_total_24h: string | number;
  execution_success_24h: string | number;
  production_failures_24h: string | number;
  trial_failures_24h: string | number;
  connectors_total: string | number;
  connectors_healthy: string | number;
  repairs_applied: string | number;
  repairs_decided: string | number;
  skills_total: string | number;
  pending_skill_candidates: string | number;
}

const CACHE_MS = 10_000;
const cache = new Map<string, { until: number; value: Promise<OperationalOverview> }>();

export function invalidateOperationalOverview(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

const numberOf = (value: string | number | null | undefined): number => Number(value ?? 0);

function metric(input: {
  id: string;
  label: string;
  definition: string;
  relevance: string;
  kind: OperationalMetric["kind"];
  value: number | null;
  unit: OperationalMetric["unit"];
  severity: Severity;
  required?: boolean;
  generatedAt: string;
  path: string;
  labelId: string;
  prometheus: string;
}): OperationalMetric {
  return {
    id: input.id,
    label: input.label,
    definition: input.definition,
    relevance: input.relevance,
    kind: input.kind,
    value: input.value,
    value_state: input.value === null ? "missing" : input.value === 0 ? "zero" : "observed",
    unit: input.unit,
    severity: input.value === null ? "unknown" : input.severity,
    required: input.required ?? false,
    source_updated_at: input.generatedAt,
    expected_interval_seconds: 30,
    stale_after_seconds: 90,
    drilldown: { path: input.path, label_id: input.labelId },
    prometheus: { name: input.prometheus, type: "gauge" },
  };
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | null)?.rows ?? [];
}

async function buildSnapshot(db: Db, tenantId: string): Promise<OperationalOverview> {
  const generatedAt = new Date().toISOString();
  const candidates = await db
    .select()
    .from(patchCandidates)
    .where(and(eq(patchCandidates.tenant_id, tenantId), eq(patchCandidates.status, "proposed")));
  const readiness = await readPatchReadinessBatch(tenantId, candidates, db);
  const readyIds = candidates
    .filter((_, index) => readiness[index]?.reviewable)
    .map((candidate) => candidate.id);
  const readyPatches = readyIds.length
    ? sql`id IN (${sql.join(
        readyIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql`FALSE`;

  const result = await db.execute<SnapshotRow>(sql`
    WITH decisions AS (
      SELECT created_at, FALSE AS blocking FROM patch_candidates
       WHERE tenant_id = ${tenantId} AND status = 'proposed' AND ${readyPatches}
      UNION ALL
      SELECT created_at, FALSE AS blocking FROM skill_candidates
       WHERE tenant_id = ${tenantId} AND status = 'proposed' AND pattern_kind NOT IN ('failure_pattern', 'authoring_capability')
    ), finished AS (
      SELECT status, source_kind, request_source FROM executions
       WHERE tenant_id = ${tenantId} AND finished_at >= now() - interval '24 hours'
    )
    SELECT
      (SELECT count(*) FROM decisions WHERE blocking) AS blocked,
      (SELECT count(*) FROM decisions WHERE NOT blocking AND created_at <= now() - interval '72 hours') AS overdue,
      (SELECT count(*) FROM decisions WHERE NOT blocking AND created_at > now() - interval '72 hours') AS other_decisions,
      (SELECT count(*) FROM workflows WHERE tenant_id = ${tenantId} AND lifecycle = 'active' AND deleted_at IS NULL) AS active_workflows,
      (SELECT count(*) FROM finished) AS execution_total_24h,
      (SELECT count(*) FROM finished WHERE status = 'succeeded') AS execution_success_24h,
      (SELECT count(*) FROM finished WHERE status IN ('failed', 'timed_out') AND source_kind = 'saved' AND request_source = 'scheduler') AS production_failures_24h,
      (SELECT count(*) FROM finished WHERE status IN ('failed', 'timed_out') AND (source_kind IN ('draft', 'step') OR request_source <> 'scheduler')) AS trial_failures_24h,
      (SELECT count(*) FROM connectors WHERE tenant_id = ${tenantId} AND enabled = TRUE AND deleted_at IS NULL) AS connectors_total,
      (SELECT count(*) FROM connectors WHERE tenant_id = ${tenantId} AND enabled = TRUE AND deleted_at IS NULL AND health_state = 'ok') AS connectors_healthy,
      (SELECT count(*) FROM patch_candidates WHERE tenant_id = ${tenantId} AND status = 'applied') AS repairs_applied,
      (SELECT count(*) FROM patch_candidates WHERE tenant_id = ${tenantId} AND status IN ('applied', 'rejected', 'superseded')) AS repairs_decided,
      (SELECT count(*) FROM skills WHERE tenant_id = ${tenantId}) AS skills_total,
      (SELECT count(*) FROM skill_candidates WHERE tenant_id = ${tenantId} AND status = 'proposed') AS pending_skill_candidates
  `);
  const row = rowsOf<SnapshotRow>(result)[0];
  if (!row) throw new Error("operational overview aggregate query returned no row");

  const blocked = numberOf(row.blocked);
  const overdue = numberOf(row.overdue);
  const other = numberOf(row.other_decisions);
  const executions = numberOf(row.execution_total_24h);
  const successes = numberOf(row.execution_success_24h);
  const connectors = numberOf(row.connectors_total);
  const healthyConnectors = numberOf(row.connectors_healthy);
  const successRatio = executions > 0 ? successes / executions : null;
  const connectorRatio = connectors > 0 ? healthyConnectors / connectors : null;
  const repairsDecided = numberOf(row.repairs_decided);
  const repairAppliedRatio =
    repairsDecided > 0 ? numberOf(row.repairs_applied) / repairsDecided : null;
  const blockingScore = Math.max(0, 100 - blocked * 10);
  const completeHealth = successRatio !== null && connectorRatio !== null;
  const healthScore = completeHealth
    ? Math.round(blockingScore * 0.5 + successRatio * 100 * 0.3 + connectorRatio * 100 * 0.2)
    : null;
  const healthState: HealthState =
    healthScore === null
      ? "unknown"
      : healthScore >= 90
        ? "healthy"
        : healthScore >= 70
          ? "limited"
          : "critical";
  const core = (input: Parameters<typeof metric>[0]) => metric({ ...input, required: true });
  const blockedMetric = core({
    id: "decisions.blocked",
    label: "Blocked",
    definition: "Conversations waiting for human input before work can continue.",
    relevance: "The authoring loop is paused until a person answers.",
    kind: "count",
    value: blocked,
    unit: "count",
    severity: blocked > 0 ? "critical" : "healthy",
    generatedAt,
    path: "/cockpit/decisions?bucket=blocked",
    labelId: "operational.open_blocked",
    prometheus: "subkit_operational_blocked",
  });
  const overdueMetric = core({
    id: "decisions.overdue",
    label: "Overdue",
    definition: "Non-blocking repair or skill proposals waiting longer than 72 hours.",
    relevance: "Old proposals allow avoidable risk or learning debt to accumulate.",
    kind: "count",
    value: overdue,
    unit: "count",
    severity: overdue > 0 ? "urgent" : "healthy",
    generatedAt,
    path: "/cockpit/decisions?bucket=overdue",
    labelId: "operational.open_overdue",
    prometheus: "subkit_operational_overdue",
  });
  const otherMetric = core({
    id: "decisions.other",
    label: "Other decisions",
    definition: "Recent repair and skill proposals that do not block workflow execution.",
    relevance: "These proposals still require accountable review.",
    kind: "count",
    value: other,
    unit: "count",
    severity: other > 0 ? "information" : "healthy",
    generatedAt,
    path: "/cockpit/decisions?bucket=other",
    labelId: "operational.open_other",
    prometheus: "subkit_operational_other_decisions",
  });
  const healthMetric = {
    ...core({
      id: "operations.health",
      label: "Operational health",
      definition: "Weighted score from blockers, execution success and connector health.",
      relevance: "It summarizes whether SubKit can run workflows reliably.",
      kind: "score",
      value: healthScore,
      unit: "count",
      severity:
        healthState === "healthy"
          ? "healthy"
          : healthState === "limited"
            ? "urgent"
            : healthState === "critical"
              ? "critical"
              : "unknown",
      generatedAt,
      path: "/cockpit/operations",
      labelId: "operational.open_health",
      prometheus: "subkit_operational_health_score",
    }),
    state: healthState,
    components: [
      {
        id: "decisions.blocked",
        raw_value: blocked,
        unit: "count",
        normalized_score: blockingScore,
        weight: 0.5,
        contribution: blockingScore * 0.5,
        freshness: "fresh" as const,
        required: true,
      },
      {
        id: "executions.success_ratio",
        raw_value: successRatio,
        unit: "ratio",
        normalized_score: successRatio === null ? null : successRatio * 100,
        weight: 0.3,
        contribution: successRatio === null ? null : successRatio * 30,
        freshness: successRatio === null ? ("missing" as const) : ("fresh" as const),
        required: true,
      },
      {
        id: "connectors.healthy_ratio",
        raw_value: connectorRatio,
        unit: "ratio",
        normalized_score: connectorRatio === null ? null : connectorRatio * 100,
        weight: 0.2,
        contribution: connectorRatio === null ? null : connectorRatio * 20,
        freshness: connectorRatio === null ? ("missing" as const) : ("fresh" as const),
        required: true,
      },
    ],
  };
  const freshnessMetric = {
    ...core({
      id: "data.freshness",
      label: "Data freshness",
      definition: "Age of the database snapshot used by every dashboard value.",
      relevance: "Fresh aggregates prevent decisions based on stale execution state.",
      kind: "duration",
      value: 0,
      unit: "seconds",
      severity: "healthy",
      generatedAt,
      path: "/cockpit/operations",
      labelId: "operational.open_data",
      prometheus: "subkit_operational_data_age_seconds",
    }),
    state: "fresh" as const,
    sources: [
      {
        id: "subkit.database",
        updated_at: generatedAt,
        expected_interval_seconds: 30,
        stale_after_seconds: 90,
        state: "fresh" as const,
      },
    ],
  };
  const product = (input: Omit<Parameters<typeof metric>[0], "generatedAt">) =>
    metric({ ...input, generatedAt });
  const sections: OperationalOverview["sections"] = [
    {
      id: "workflows",
      title: "Workflows",
      visualization: "kpi",
      drilldown: {
        path: "/cockpit/workflows",
        label_id: "operational.open_workflows",
      },
      metrics: [
        product({
          id: "automation.active_workflows",
          label: "Active workflows",
          definition: "Published workflows in the active lifecycle.",
          relevance: "Shows runnable automation scope.",
          kind: "count",
          value: numberOf(row.active_workflows),
          unit: "count",
          severity: "information",
          path: "/cockpit/workflows",
          labelId: "operational.open_workflows",
          prometheus: "subkit_operational_active_workflows",
        }),
        product({
          id: "executions.total_24h",
          label: "Execution volume (24h)",
          definition: "Workflow executions finished in the last 24 hours.",
          relevance: "Shows current automation activity.",
          kind: "count",
          value: executions,
          unit: "count",
          severity: "information",
          path: "/cockpit/runs",
          labelId: "operational.open_runs",
          prometheus: "subkit_operational_execution_volume_24h",
        }),
      ],
    },
    {
      id: "reliability",
      title: "Reliability",
      visualization: "kpi",
      drilldown: { path: "/cockpit/runs", label_id: "operational.open_runs" },
      metrics: [
        product({
          id: "executions.success_ratio",
          label: "Execution success",
          definition: "Successful executions divided by all runs finished in 24 hours.",
          relevance: "Shows recent workflow reliability.",
          kind: "ratio",
          value: successRatio,
          unit: "ratio",
          severity:
            successRatio === null
              ? "unknown"
              : successRatio >= 0.9
                ? "healthy"
                : successRatio >= 0.7
                  ? "urgent"
                  : "critical",
          path: "/cockpit/runs",
          labelId: "operational.open_runs",
          prometheus: "subkit_operational_execution_success_ratio",
        }),
        product({
          id: "executions.incidents_24h",
          label: "Production incidents",
          definition: "Failed scheduled workflow executions in the last 24 hours.",
          relevance: "Separates real operational incidents from authoring trials.",
          kind: "count",
          value: numberOf(row.production_failures_24h),
          unit: "count",
          severity: numberOf(row.production_failures_24h) > 0 ? "critical" : "healthy",
          path: "/cockpit/runs",
          labelId: "operational.open_runs",
          prometheus: "subkit_operational_production_incidents_24h",
        }),
        product({
          id: "executions.trial_failures_24h",
          label: "Trial failures",
          definition: "Failed authoring or manual test executions in the last 24 hours.",
          relevance: "Keeps test feedback distinct from production incidents.",
          kind: "count",
          value: numberOf(row.trial_failures_24h),
          unit: "count",
          severity: "information",
          path: "/cockpit/runs",
          labelId: "operational.open_runs",
          prometheus: "subkit_operational_trial_failures_24h",
        }),
      ],
    },
    {
      id: "connections",
      title: "Connections",
      visualization: "progress",
      drilldown: {
        path: "/cockpit/connectors",
        label_id: "operational.open_connectors",
      },
      metrics: [
        product({
          id: "connectors.healthy_ratio",
          label: "Connector health",
          definition: "Healthy enabled connectors divided by all enabled connectors.",
          relevance: "Shows whether workflows can reach their systems.",
          kind: "ratio",
          value: connectorRatio,
          unit: "ratio",
          severity:
            connectorRatio === null
              ? "unknown"
              : connectorRatio >= 0.9
                ? "healthy"
                : connectorRatio >= 0.7
                  ? "urgent"
                  : "critical",
          path: "/cockpit/connectors",
          labelId: "operational.open_connectors",
          prometheus: "subkit_operational_connector_health_ratio",
        }),
      ],
    },
    {
      id: "learning",
      title: "Learning",
      visualization: "kpi",
      drilldown: {
        path: "/cockpit/skills",
        label_id: "operational.open_skills",
      },
      metrics: [
        product({
          id: "repairs.applied_ratio",
          label: "Repair application rate",
          definition: "Applied self-healing patches divided by all decided patches.",
          relevance: "Shows how often proposed repairs become accepted operational changes.",
          kind: "ratio",
          value: repairAppliedRatio,
          unit: "ratio",
          severity:
            repairAppliedRatio === null
              ? "unknown"
              : repairAppliedRatio >= 0.7
                ? "healthy"
                : "information",
          path: "/cockpit/decisions",
          labelId: "operational.open_decisions",
          prometheus: "subkit_operational_repairs_applied_ratio",
        }),
        product({
          id: "skills.reusable",
          label: "Skills",
          definition: "Reusable skills available to authoring conversations.",
          relevance: "Shows the learned capability base.",
          kind: "count",
          value: numberOf(row.skills_total),
          unit: "count",
          severity: "information",
          path: "/cockpit/skills",
          labelId: "operational.open_skills",
          prometheus: "subkit_operational_skills_total",
        }),
      ],
    },
  ];

  return {
    schema_version: OPERATIONAL_SCHEMA_VERSION,
    contract_version: FAMILY_CONTRACT_VERSION,
    product: "subkit",
    generated_at: generatedAt,
    recommended_refresh_seconds: 30,
    snapshot_state: completeHealth ? "ready" : "partial",
    core: {
      blocked: blockedMetric,
      overdue: overdueMetric,
      other_decisions: otherMetric,
      health: healthMetric,
      data_freshness: freshnessMetric,
    },
    sections,
    audit: {
      path: "/cockpit/audit",
      contract_version: FAMILY_CONTRACT_VERSION,
      snapshot_generated_at: generatedAt,
    },
  };
}

export function getOperationalOverview(db: Db, tenantId: string): Promise<OperationalOverview> {
  const now = Date.now();
  const existing = cache.get(tenantId);
  if (existing && existing.until > now) return existing.value;
  const value = buildSnapshot(db, tenantId).catch((error) => {
    cache.delete(tenantId);
    throw error;
  });
  cache.set(tenantId, { until: now + CACHE_MS, value });
  return value;
}

export function projectOperationalOverviewMetrics(snapshot: OperationalOverview): void {
  const registry = getMetrics();
  const all = [
    snapshot.core.blocked,
    snapshot.core.overdue,
    snapshot.core.other_decisions,
    snapshot.core.health,
    snapshot.core.data_freshness,
    ...snapshot.sections.flatMap((section) => section.metrics),
  ];
  for (const entry of all)
    if (entry.value !== null && entry.value_state !== "forbidden")
      registry.set(entry.prometheus.name, entry.value);
}
