import { and, desc, eq, sql } from "drizzle-orm";
import {
  connectorCountsAgainstHealth,
  connectorCountsTowardHealth,
} from "../connectors/health-ratio.ts";
import type { ConnectorHealthState } from "../connectors/health-state.ts";
import type { Db } from "../db/client.ts";
import { connectors, selfHealingScans, tenants } from "../db/schema/index.ts";
import type { PreviewClassification } from "../execution/classify.ts";
import { getMetrics } from "../observability/index.ts";
import { readOpenPatchDecisions } from "../self-healing/index.ts";
import {
  collectFailureGroups,
  DECISION_FAILURE_WINDOW_HOURS,
  failingScheduledGroups,
} from "./health-digest.ts";
import {
  cockpitRunsHref,
  readOperatingFigures,
  resolveOperatingBounds,
} from "./operating-figures.ts";
import { registerTenantStateCache } from "./tenant-state.ts";

export const OPERATIONAL_SCHEMA_VERSION = "operational-overview.v1" as const;
export const OPERATIONAL_OVERVIEW_CONTRACT_VERSION = "2.3" as const;

export type ValueState = "observed" | "zero" | "missing" | "stale" | "forbidden";
export type Freshness = "fresh" | "stale" | "missing" | "forbidden";
export interface Drilldown {
  path: string;
  label_id: string;
}
export type HealthCauseReason =
  | "held_for_review"
  | "failing"
  | "needs_reauth"
  | "needs_update"
  | "degraded"
  | "unhealthy";

export interface HealthCauseSubject {
  kind: "workflow" | "connector";
  id: string | null;
  name: string | null;
}

export interface HealthCause {
  kind: "failing_group" | "held_schedule" | "held_inbound_hook" | "connector";
  id: string;
  label: string;
  subject: HealthCauseSubject;
  reason: HealthCauseReason;
  detail: string | null;
  cause_class: PreviewClassification | null;
  drilldown: Drilldown;
}

const CONNECTOR_REASON = {
  needs_reauth: "needs_reauth",
  needs_update: "needs_update",
  degraded: "degraded",
} as const satisfies Record<Exclude<ConnectorHealthState, "ok">, HealthCauseReason>;

function connectorReason(state: string): HealthCauseReason {
  return (CONNECTOR_REASON as Record<string, HealthCauseReason>)[state] ?? "unhealthy";
}
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
  drilldown: Drilldown;
  prometheus: { name: string; type: "gauge" | "counter" };
}

export interface OperationalOverview {
  schema_version: typeof OPERATIONAL_SCHEMA_VERSION;
  contract_version: typeof OPERATIONAL_OVERVIEW_CONTRACT_VERSION;
  product: "subkit";
  generated_at: string;
  recommended_refresh_seconds: number;
  snapshot_state: "ready" | "partial" | "forbidden" | "contract-mismatch";
  core: {
    blocked: OperationalMetric;
    failing: OperationalMetric;
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
        freshness: Freshness;
        required: boolean;
        drilldown: Drilldown;
      }>;
      causes: HealthCause[];
    };
    data_freshness: OperationalMetric & {
      state: Freshness;
      sources: FreshnessSource[];
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
    contract_version: typeof OPERATIONAL_OVERVIEW_CONTRACT_VERSION;
    snapshot_generated_at: string;
  };
}

export interface FreshnessSource {
  id: string;
  updated_at: string | null;
  expected_interval_seconds: number;
  stale_after_seconds: number;
  state: Freshness;
  drilldown: Drilldown;
}

export const MAX_HEALTH_CAUSES = 5;

export const FRESHNESS_EXPECTED_INTERVAL_SECONDS = 60 * 60;
export const FRESHNESS_STALE_AFTER_SECONDS = 3 * FRESHNESS_EXPECTED_INTERVAL_SECONDS;

interface SnapshotRow extends Record<string, unknown> {
  blocked: string | number;
  overdue: string | number;
  other_decisions: string | number;
  active_workflows: string | number;
  execution_total_24h: string | number;
  production_failures_24h: string | number;
  trial_failures_24h: string | number;
  connectors_total: string | number;
  connectors_not_ok: string | number;
  skills_total: string | number;
  pending_skill_candidates: string | number;
}

const CACHE_MS = 10_000;
const cache = new Map<string, { until: number; value: Promise<OperationalOverview> }>();

export function invalidateOperationalOverview(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}
registerTenantStateCache(invalidateOperationalOverview);

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

function heldAutomation(tenantId: string) {
  return sql`
    SELECT w.id AS workflow_id, w.name AS name, 'held_schedule' AS kind, s.created_at
      FROM workflows_schedules s
      JOIN workflows w ON w.id = s.workflow_id AND w.tenant_id = s.tenant_id
     WHERE s.tenant_id = ${tenantId} AND NOT s.paused AND s.admission_hold IS NOT NULL
       AND w.deleted_at IS NULL AND w.lifecycle <> 'archived'
    UNION ALL
    SELECT w.id, w.name, 'held_inbound_hook', h.created_at
      FROM webhooks_inbound h
      JOIN workflows w ON w.id = h.workflow_id AND w.tenant_id = h.tenant_id
     WHERE h.tenant_id = ${tenantId} AND h.active AND h.admission_hold IS NOT NULL
       AND w.deleted_at IS NULL AND w.lifecycle <> 'archived'
       AND NOT EXISTS (
         SELECT 1 FROM workflows_schedules s
          WHERE s.tenant_id = h.tenant_id AND s.workflow_id = h.workflow_id
            AND NOT s.paused AND s.admission_hold IS NOT NULL)`;
}

async function buildSnapshot(db: Db, tenantId: string): Promise<OperationalOverview> {
  const now = new Date();
  const generatedAt = now.toISOString();
  const openPatches = await readOpenPatchDecisions(db, tenantId);
  const readyIds = openPatches.items.map((item) => item.row.id);
  const readyPatches = readyIds.length
    ? sql`id IN (${sql.join(
        readyIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql`FALSE`;

  const failingGroups = failingScheduledGroups(
    await collectFailureGroups(db, tenantId, DECISION_FAILURE_WINDOW_HOURS),
  );
  const failing = failingGroups.length;

  const bounds = resolveOperatingBounds({ window: "24h" }, now);
  if (!bounds.ok) throw new Error(`operational overview window: ${bounds.reason}`);
  const figures = await readOperatingFigures(db, tenantId, bounds);

  const result = await db.execute<SnapshotRow>(sql`
    WITH decisions AS (
      SELECT created_at, FALSE AS blocking FROM patch_candidates
       WHERE tenant_id = ${tenantId} AND status = 'proposed' AND ${readyPatches}
      UNION ALL
      SELECT created_at, FALSE AS blocking FROM skill_candidates
       WHERE tenant_id = ${tenantId} AND status = 'proposed'
      UNION ALL
      SELECT created_at, TRUE AS blocking FROM (${heldAutomation(tenantId)}) held
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
      (SELECT count(*) FROM finished WHERE status IN ('failed', 'timed_out') AND source_kind = 'saved' AND request_source = 'scheduler') AS production_failures_24h,
      (SELECT count(*) FROM finished WHERE status IN ('failed', 'timed_out') AND (source_kind IN ('draft', 'step') OR request_source <> 'scheduler')) AS trial_failures_24h,
      (SELECT count(*) FROM connectors WHERE tenant_id = ${tenantId} AND ${connectorCountsTowardHealth()}) AS connectors_total,
      (SELECT count(*) FROM connectors WHERE tenant_id = ${tenantId} AND ${connectorCountsAgainstHealth()}) AS connectors_not_ok,
      (SELECT count(*) FROM skills WHERE tenant_id = ${tenantId}) AS skills_total,
      (SELECT count(*) FROM skill_candidates WHERE tenant_id = ${tenantId} AND status = 'proposed') AS pending_skill_candidates
  `);
  const row = rowsOf<SnapshotRow>(result)[0];
  if (!row) throw new Error("operational overview aggregate query returned no row");

  const blocked = numberOf(row.blocked);
  const overdue = numberOf(row.overdue);
  const other = numberOf(row.other_decisions);
  const executions = numberOf(row.execution_total_24h);
  const connectors = numberOf(row.connectors_total);
  const healthyConnectors = connectors - numberOf(row.connectors_not_ok);
  const successRatio =
    figures.runs.finished > 0 ? figures.runs.succeeded / figures.runs.finished : null;
  const connectorRatio = connectors > 0 ? healthyConnectors / connectors : null;
  const repairAppliedRatio =
    figures.repairs.decided > 0 ? figures.repairs.applied / figures.repairs.decided : null;
  const blockingScore = Math.max(0, 100 - blocked * 10);
  const completeHealth = successRatio !== null && connectorRatio !== null;
  const healthScore = completeHealth
    ? Math.round(blockingScore * 0.5 + successRatio * 100 * 0.3 + connectorRatio * 100 * 0.2)
    : null;
  const healthState: HealthState =
    blocked > 0
      ? "critical"
      : healthScore === null
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
    definition: "Scheduled workflows whose last admission was held for execution review.",
    relevance:
      "Review the workflow effects and its finite execution authority; no run is queued while held.",
    kind: "count",
    value: blocked,
    unit: "count",
    severity: blocked > 0 ? "critical" : "healthy",
    generatedAt,
    path: ATTENTION_PATH,
    labelId: "operational.open_blocked",
    prometheus: "subkit_operational_blocked",
  });
  const failingMetric = core({
    id: "decisions.failing",
    label: "Failing",
    definition:
      "Approved scheduled workflows that ran and failed in the last 7 days, grouped by cause.",
    relevance:
      "A workflow nobody has to approve can still be broken; this is the decision that has no held schedule behind it.",
    kind: "count",
    value: failing,
    unit: "count",
    severity: failing > 0 ? "urgent" : "healthy",
    generatedAt,
    path: ATTENTION_PATH,
    labelId: "operational.open_failing",
    prometheus: "subkit_operational_failing",
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
    path: ATTENTION_PATH,
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
    path: ATTENTION_PATH,
    labelId: "operational.open_other",
    prometheus: "subkit_operational_other_decisions",
  });
  const components = [
    {
      id: "decisions.blocked",
      raw_value: blocked,
      unit: "count",
      normalized_score: blockingScore,
      weight: 0.5,
      contribution: blockingScore * 0.5,
      freshness: "fresh" as const,
      required: true,
      drilldown: {
        path: ATTENTION_PATH,
        label_id: "operational.open_blocked",
      },
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
      drilldown: {
        path: cockpitRunsHref({ status: "failed", source: "scheduler" }),
        label_id: "operational.open_runs",
      },
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
      drilldown: {
        path: NOT_OK_CONNECTORS_PATH,
        label_id: "operational.open_connectors",
      },
    },
  ];
  const causes = await readHealthCauses(db, tenantId, failingGroups);
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
      ...worstComponentLink(components, blocked),
      prometheus: "subkit_operational_health_score",
    }),
    severity: (healthState === "critical"
      ? "critical"
      : healthState === "healthy"
        ? "healthy"
        : healthState === "limited"
          ? "urgent"
          : "unknown") as Severity,
    state: healthState,
    components,
    causes,
  };
  const freshnessMetric = await readDataFreshness(db, tenantId, now, core);
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
          path: cockpitRunsHref(),
          labelId: "operational.open_runs",
          prometheus: "subkit_operational_execution_volume_24h",
        }),
      ],
    },
    {
      id: "reliability",
      title: "Reliability",
      visualization: "kpi",
      drilldown: { path: cockpitRunsHref(), label_id: "operational.open_runs" },
      metrics: [
        product({
          id: "executions.success_ratio",
          label: "Execution success",
          definition:
            "Successful runs divided by the runs started in the last 24 hours that have ended, as GET /v1/stats/operating-figures counts them; a run still queued or running counts neither way.",
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
          path: cockpitRunsHref(),
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
          path: cockpitRunsHref({ status: "failed", source: "scheduler" }),
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
          path: cockpitRunsHref({ status: "failed" }),
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
          path: NOT_OK_CONNECTORS_PATH,
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
          definition:
            "Repairs approved or applied automatically divided by all repairs decided (approved, applied automatically, rejected) in the last 24 hours, as GET /v1/stats/operating-figures counts them.",
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
          path: DECIDED_REPAIRS_PATH,
          labelId: "operational.open_decided_repairs",
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
    contract_version: OPERATIONAL_OVERVIEW_CONTRACT_VERSION,
    product: "subkit",
    generated_at: generatedAt,
    recommended_refresh_seconds: 30,
    snapshot_state: completeHealth ? "ready" : "partial",
    core: {
      blocked: blockedMetric,
      failing: failingMetric,
      overdue: overdueMetric,
      other_decisions: otherMetric,
      health: healthMetric,
      data_freshness: freshnessMetric,
    },
    sections,
    audit: {
      path: "/cockpit/audit",
      contract_version: OPERATIONAL_OVERVIEW_CONTRACT_VERSION,
      snapshot_generated_at: generatedAt,
    },
  };
}

export const NOT_OK_CONNECTORS_PATH = "/cockpit/connectors?health=not_ok";

export const ATTENTION_PATH = "/cockpit";

function workflowReviewPath(workflowId: string): string {
  return `/cockpit?review=workflow:${workflowId}`;
}

export const DECIDED_REPAIRS_PATH =
  "/cockpit/audit?scope=all&action=patch_candidate.approved,patch_candidate.auto_applied,patch_candidate.rejected";

function worstComponentLink(
  components: ReadonlyArray<{ normalized_score: number | null; drilldown: Drilldown }>,
  blocked: number,
): { path: string; labelId: string } {
  const scored = components.filter((c) => c.normalized_score !== null);
  const worst =
    blocked > 0 || scored.length === 0
      ? components[0]
      : scored.reduce((a, b) => ((b.normalized_score ?? 0) < (a.normalized_score ?? 0) ? b : a));
  const link = worst?.drilldown ?? {
    path: ATTENTION_PATH,
    label_id: "operational.open_blocked",
  };
  return { path: link.path, labelId: link.label_id };
}

async function readHealthCauses(
  db: Db,
  tenantId: string,
  failingGroups: ReadonlyArray<{
    signature: string;
    workflow_id: string | null;
    workflow_name: string | null;
    cause: string;
    cause_class: PreviewClassification;
  }>,
): Promise<HealthCause[]> {
  type Held = { workflow_id: string; name: string; kind: HealthCause["kind"] & `held_${string}` };
  const held = rowsOf<Held>(
    await db.execute(sql`
      SELECT workflow_id, name, kind FROM (${heldAutomation(tenantId)}) held
       ORDER BY created_at, workflow_id
       LIMIT ${MAX_HEALTH_CAUSES}`),
  );
  const causes: HealthCause[] = held.map((row) => ({
    kind: row.kind,
    id: row.workflow_id,
    label: `${row.name}: automatic runs held for review`,
    subject: { kind: "workflow", id: row.workflow_id, name: row.name },
    reason: "held_for_review",
    detail: null,
    cause_class: null,
    drilldown: { path: workflowReviewPath(row.workflow_id), label_id: "operational.open_blocked" },
  }));
  for (const group of failingGroups) {
    causes.push({
      kind: "failing_group",
      id: group.signature,
      label: `${group.workflow_name ?? group.workflow_id ?? "workflow"}: ${group.cause}`,
      subject: { kind: "workflow", id: group.workflow_id, name: group.workflow_name },
      reason: "failing",
      detail: group.cause,
      cause_class: group.cause_class,
      drilldown: {
        path: group.workflow_id ? workflowReviewPath(group.workflow_id) : ATTENTION_PATH,
        label_id: "operational.open_failing",
      },
    });
  }
  if (causes.length < MAX_HEALTH_CAUSES) {
    const unhealthy = await db
      .select({
        id: connectors.id,
        name: connectors.display_name,
        health_state: connectors.health_state,
        needs_reauth: connectors.needs_reauth,
        health_reason: connectors.health_reason,
      })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), connectorCountsAgainstHealth()))
      .orderBy(connectors.display_name, connectors.id)
      .limit(MAX_HEALTH_CAUSES);
    for (const row of unhealthy) {
      const reason = row.needs_reauth ? "needs_reauth" : connectorReason(row.health_state);
      causes.push({
        kind: "connector",
        id: row.id,
        label: `${row.name}: ${reason.replace(/_/g, " ")}`,
        subject: { kind: "connector", id: row.id, name: row.name },
        reason,
        detail: row.health_reason ?? (reason === "unhealthy" ? row.health_state : null),
        cause_class: null,
        drilldown: {
          path: `/cockpit/connectors/${encodeURIComponent(row.id)}`,
          label_id: "operational.open_connector",
        },
      });
    }
  }
  return causes.slice(0, MAX_HEALTH_CAUSES);
}

function freshnessOf(updatedAt: Date | null, now: Date): Freshness {
  if (!updatedAt) return "missing";
  return (now.getTime() - updatedAt.getTime()) / 1000 > FRESHNESS_STALE_AFTER_SECONDS
    ? "stale"
    : "fresh";
}

async function readDataFreshness(
  db: Db,
  tenantId: string,
  now: Date,
  core: (input: Parameters<typeof metric>[0]) => OperationalMetric,
): Promise<OperationalOverview["core"]["data_freshness"]> {
  const [scan] = await db
    .select({ at: selfHealingScans.updated_at })
    .from(selfHealingScans)
    .where(
      and(
        eq(selfHealingScans.tenant_id, tenantId),
        eq(selfHealingScans.source, "scheduler"),
        eq(selfHealingScans.status, "succeeded"),
      ),
    )
    .orderBy(desc(selfHealingScans.updated_at))
    .limit(1);
  const [tenant] = await db
    .select({ at: tenants.last_connector_reauth_scan_at })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const observed: Array<{ id: string; at: Date | null; drilldown: Drilldown }> = [
    {
      id: "self_healing.drift_scan",
      at: scan?.at ?? null,
      drilldown: { path: "/cockpit/audit?scope=operations", label_id: "operational.open_scans" },
    },
    {
      id: "connectors.reauth_scan",
      at: tenant?.at ?? null,
      drilldown: { path: "/cockpit/connectors", label_id: "operational.open_connectors" },
    },
  ];
  const sources: FreshnessSource[] = observed.map((source) => ({
    id: source.id,
    updated_at: source.at?.toISOString() ?? null,
    expected_interval_seconds: FRESHNESS_EXPECTED_INTERVAL_SECONDS,
    stale_after_seconds: FRESHNESS_STALE_AFTER_SECONDS,
    state: freshnessOf(source.at, now),
    drilldown: source.drilldown,
  }));
  const stalest = observed.reduce((a, b) =>
    !a.at ? a : !b.at ? b : b.at.getTime() < a.at.getTime() ? b : a,
  );
  const state: Freshness = sources.some((s) => s.state === "stale")
    ? "stale"
    : sources.some((s) => s.state === "missing")
      ? "missing"
      : "fresh";
  const age = stalest.at
    ? Math.max(0, Math.round((now.getTime() - stalest.at.getTime()) / 1000))
    : null;
  const base = core({
    id: "data.freshness",
    label: "Data freshness",
    definition:
      "Age of the oldest scheduler heartbeat behind these numbers: the drift scan and the connector re-auth scan.",
    relevance:
      "A stopped scheduler freezes repair and connector state; stale numbers must not read as healthy.",
    kind: "duration",
    value: age,
    unit: "seconds",
    severity: state === "stale" ? "critical" : state === "missing" ? "unknown" : "healthy",
    generatedAt: now.toISOString(),
    path: stalest.drilldown.path,
    labelId: stalest.drilldown.label_id,
    prometheus: "subkit_operational_data_age_seconds",
  });
  return {
    ...base,
    value_state: state === "stale" ? "stale" : base.value_state,
    source_updated_at: stalest.at?.toISOString() ?? null,
    expected_interval_seconds: FRESHNESS_EXPECTED_INTERVAL_SECONDS,
    stale_after_seconds: FRESHNESS_STALE_AFTER_SECONDS,
    state,
    sources,
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
    snapshot.core.failing,
    snapshot.core.overdue,
    snapshot.core.other_decisions,
    snapshot.core.health,
    snapshot.core.data_freshness,
    ...snapshot.sections.flatMap((section) => section.metrics),
  ];
  for (const entry of all) {
    if (entry.value_state === "forbidden") continue;
    registry.set(entry.prometheus.name, entry.value ?? Number.NaN);
  }
}
