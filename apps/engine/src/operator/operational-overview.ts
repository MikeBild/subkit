import { and, desc, eq, sql } from "drizzle-orm";
import {
  connectorCountsAgainstHealth,
  connectorCountsTowardHealth,
} from "../connectors/health-ratio.ts";
import type { Db } from "../db/client.ts";
import { connectors, selfHealingScans, tenants } from "../db/schema/index.ts";
import { getMetrics } from "../observability/index.ts";
import { readOpenPatchDecisions } from "../self-healing/index.ts";
import {
  collectFailureGroups,
  DECISION_FAILURE_WINDOW_HOURS,
  failingScheduledGroups,
} from "./health-digest.ts";

export const OPERATIONAL_SCHEMA_VERSION = "operational-overview.v1" as const;
/**
 * The version of THIS payload — the operational overview and nothing else.
 *
 * It was called FAMILY_CONTRACT_VERSION, which sent every reader to
 * `FAMILY-UI.json` to find out why that file says 2.3. The two numbers were
 * never the same contract: `familyVersion` versions the cross-product cockpit
 * UI — geometry, DOM attributes, states — and that file already carries
 * `apiSchemaVersion` as its pointer at this payload. They are independent and
 * are meant to move independently.
 *
 * 2.2 because `core` gained a required member. The published schema
 * (`OPERATIONAL-OVERVIEW.schema.json`) declares `additionalProperties: false`
 * at both levels, so a consumer validating a new snapshot against the 2.1
 * document rejects it outright; and a consumer destructuring `core` against the
 * 2.1 shape reads `undefined`. Additive from the inside is still a break from
 * the outside. The OpenAPI response is NOT closed — no `.strict()` anywhere in
 * the route — so it is the published schema that makes this a version.
 *
 * 2.3 is additive: every health component carries the `drilldown` to its
 * cause, `core.health` lists the concrete `causes` behind a red score, and
 * every freshness source names its `drilldown`. The published schema is closed,
 * so the new members are declared there (optional, for the sibling products).
 */
export const OPERATIONAL_OVERVIEW_CONTRACT_VERSION = "2.3" as const;

export type ValueState = "observed" | "zero" | "missing" | "stale" | "forbidden";
export type Freshness = "fresh" | "stale" | "missing" | "forbidden";
export interface Drilldown {
  path: string;
  label_id: string;
}
/** A concrete reason a health score is not green, with where to act on it. */
export interface HealthCause {
  kind: "failing_group" | "held_schedule" | "connector";
  id: string;
  label: string;
  drilldown: Drilldown;
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
  /**
   * `buildSnapshot` only ever produces `ready` or `partial`: it runs behind the
   * permission middleware and inside the version that defines this shape, so it
   * can observe neither of the other two. They stay in the union because they
   * are the reader's vocabulary, not the writer's — a client reading this
   * payload across a version boundary, or through a gateway that stripped its
   * permission, has a name for what it is looking at instead of a parse error.
   */
  snapshot_state: "ready" | "partial" | "forbidden" | "contract-mismatch";
  core: {
    blocked: OperationalMetric;
    /** Approved, scheduled, and failing — the opposite of a held schedule. */
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
        /** Where the thing this component measures can be acted on. */
        drilldown: Drilldown;
      }>;
      /** The concrete causes behind the score, at most MAX_HEALTH_CAUSES. */
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

/** How many concrete causes `core.health` lists before it stops. */
export const MAX_HEALTH_CAUSES = 5;

/**
 * The freshness sources and their thresholds.
 *
 * Both are written by the scheduler's reconciler on an hourly cadence per
 * tenant, so each is a real heartbeat of the machinery that produces what the
 * overview counts: the drift scan feeds the repair decisions, the re-auth scan
 * feeds connector health. Stale after three missed cadences — one late tick is
 * load, three is a stopped scheduler.
 *
 *   - `self_healing.drift_scan`: newest SUCCEEDED scheduler row in
 *     `self_healing_scans`. Not the claim stamp on `tenants`, which is written
 *     before the scan runs and so proves only that it was attempted.
 *   - `connectors.reauth_scan`: `tenants.last_connector_reauth_scan_at`.
 */
export const FRESHNESS_EXPECTED_INTERVAL_SECONDS = 60 * 60;
export const FRESHNESS_STALE_AFTER_SECONDS = 3 * FRESHNESS_EXPECTED_INTERVAL_SECONDS;

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
  connectors_not_ok: string | number;
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
  const now = new Date();
  const generatedAt = now.toISOString();
  // The same predicate the digest, the MCP instructions and the list's
  // `reviewable_total` read: proposed AND reviewable on the current version.
  const openPatches = await readOpenPatchDecisions(db, tenantId);
  const readyIds = openPatches.items.map((item) => item.row.id);
  const readyPatches = readyIds.length
    ? sql`id IN (${sql.join(
        readyIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql`FALSE`;

  // Asked of the same code the decisions queue asks, not re-derived here. The
  // grouping rule is more than a WHERE clause — first failed step per run,
  // origin merged across the group, a scan cap — and a second copy of it in SQL
  // is how the overview came to disagree with the page it links to.
  const failingGroups = failingScheduledGroups(
    await collectFailureGroups(db, tenantId, DECISION_FAILURE_WINDOW_HOURS),
  );
  const failing = failingGroups.length;

  const result = await db.execute<SnapshotRow>(sql`
    WITH decisions AS (
      SELECT created_at, FALSE AS blocking FROM patch_candidates
       WHERE tenant_id = ${tenantId} AND status = 'proposed' AND ${readyPatches}
      UNION ALL
      SELECT created_at, FALSE AS blocking FROM skill_candidates
       WHERE tenant_id = ${tenantId} AND status = 'proposed' AND pattern_kind NOT IN ('failure_pattern', 'authoring_capability')
      UNION ALL
      SELECT s.created_at, TRUE AS blocking FROM workflows_schedules s
        JOIN workflows w ON w.id = s.workflow_id AND w.tenant_id = s.tenant_id
       WHERE s.tenant_id = ${tenantId} AND NOT s.paused AND s.admission_hold IS NOT NULL
         AND w.deleted_at IS NULL AND w.lifecycle <> 'archived'
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
      (SELECT count(*) FROM connectors WHERE tenant_id = ${tenantId} AND ${connectorCountsTowardHealth()}) AS connectors_total,
      (SELECT count(*) FROM connectors WHERE tenant_id = ${tenantId} AND ${connectorCountsAgainstHealth()}) AS connectors_not_ok,
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
  // The numerator is the complement of `GET /v1/connectors?health=not_ok`:
  // one predicate, so the list a red tile opens holds exactly what it counted.
  const healthyConnectors = connectors - numberOf(row.connectors_not_ok);
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
    path: "/cockpit/decisions?bucket=blocked",
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
    path: "/cockpit/decisions?bucket=failing",
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
        path: "/cockpit/decisions?bucket=blocked",
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
      // The score counts every finished run; what a person can act on is the
      // failed runs the scheduler started.
      drilldown: {
        path: "/cockpit/runs?status=failed&source=scheduler",
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
      // A red score leads to what made it red. It pointed at the operations
      // page, which says its findings are on the overview — a loop with no
      // cause at either end.
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
          // A count that names failed runs has to lead to the failed runs. It
          // pointed at the unfiltered list, where eleven thousand rows hid the
          // one the number was about.
          //
          // `status=failed` alone was still the wrong list. This metric counts
          // failed runs THE SCHEDULER STARTED — its own definition says it
          // separates those from authoring trials — and the link landed on
          // nine hundred rows that were overwhelmingly trials. The number
          // excluded exactly what the reader was then shown.
          //
          // The 24-hour window is deliberately not in the link. A cutoff
          // written into a path is a timestamp that keeps being served after
          // the snapshot behind it was recomputed, so the link would name a
          // window the number no longer used. Newest-first over the right KIND
          // of run opens on the runs this counted; it is wider in time, and
          // being wider is visible, where being wrong was not.
          path: "/cockpit/runs?status=failed&source=scheduler",
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
          path: "/cockpit/runs?status=failed",
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
          // A historical ratio leads to the decisions it was computed from, not
          // to the open queue: the approved, auto-applied and rejected repairs.
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

/**
 * The connectors behind `connectors.healthy_ratio` that pull it down: the list
 * narrowed by `GET /v1/connectors?health=not_ok`, the same predicate the ratio
 * counts against (`connectorCountsAgainstHealth`). Both the health component
 * and the section tile lead here — a ratio at 0 % links too, and the plain list
 * would hand the reader every connector instead of the broken ones.
 */
export const NOT_OK_CONNECTORS_PATH = "/cockpit/connectors?health=not_ok";

/** The audit rows behind `repairs.applied_ratio`: every decided repair. */
export const DECIDED_REPAIRS_PATH =
  "/cockpit/audit?scope=all&action=patch_candidate.approved,patch_candidate.auto_applied,patch_candidate.rejected";

/**
 * The health metric's own link: the worst-scoring component. Blocked work wins
 * outright (it makes the state critical on its own); otherwise the lowest
 * normalized score, in component order on a tie.
 */
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
    path: "/cockpit/decisions?bucket=blocked",
    label_id: "operational.open_blocked",
  };
  return { path: link.path, labelId: link.label_id };
}

/**
 * The concrete causes behind the health score, most blocking first: held
 * schedules (the blocked tile's own predicate), failing scheduled groups (the
 * failing tile's own list), then unhealthy connectors (the complement of the
 * connector ratio's numerator). Capped at MAX_HEALTH_CAUSES.
 */
async function readHealthCauses(
  db: Db,
  tenantId: string,
  failingGroups: ReadonlyArray<{
    signature: string;
    workflow_id: string | null;
    workflow_name: string | null;
    cause: string;
  }>,
): Promise<HealthCause[]> {
  const held = rowsOf<{ workflow_id: string; name: string }>(
    await db.execute(sql`
      SELECT w.id AS workflow_id, w.name AS name FROM workflows_schedules s
        JOIN workflows w ON w.id = s.workflow_id AND w.tenant_id = s.tenant_id
       WHERE s.tenant_id = ${tenantId} AND NOT s.paused AND s.admission_hold IS NOT NULL
         AND w.deleted_at IS NULL AND w.lifecycle <> 'archived'
       ORDER BY s.created_at, w.id
       LIMIT ${MAX_HEALTH_CAUSES}`),
  );
  const causes: HealthCause[] = held.map((row) => ({
    kind: "held_schedule",
    id: row.workflow_id,
    label: `${row.name}: automatic runs held for review`,
    drilldown: { path: "/cockpit/decisions?bucket=blocked", label_id: "operational.open_blocked" },
  }));
  for (const group of failingGroups) {
    causes.push({
      kind: "failing_group",
      id: group.signature,
      label: `${group.workflow_name ?? group.workflow_id ?? "workflow"}: ${group.cause}`,
      drilldown: {
        path: "/cockpit/decisions?bucket=failing",
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
      })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), connectorCountsAgainstHealth()))
      .orderBy(connectors.display_name, connectors.id)
      .limit(MAX_HEALTH_CAUSES);
    for (const row of unhealthy) {
      causes.push({
        kind: "connector",
        id: row.id,
        label: `${row.name}: ${row.health_state.replace(/_/g, " ")}`,
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

/**
 * `data.freshness` from the ages of the sources that feed the overview.
 *
 * It was a constant — value 0, always fresh — so it could never turn red,
 * however long the scheduler had been stopped. The value is now the age in
 * seconds of the stalest source, and the metric's link names that source.
 */
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
  // The stalest source decides: a missing one first (nothing has ever run),
  // then the oldest timestamp.
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
  for (const entry of all)
    if (entry.value !== null && entry.value_state !== "forbidden")
      registry.set(entry.prometheus.name, entry.value);
}
