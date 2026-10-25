import { totalmem } from "node:os";
import { and, eq, inArray, like, notInArray, or, sql } from "drizzle-orm";
import { getConfig } from "../config/loader.ts";
import type { Config } from "../config/schema.ts";
import type { Executor } from "../db/client.ts";
import { riskSignalEdges } from "../db/schema/index.ts";
import {
  BUDGET_CRITICAL_SHARE,
  BUDGET_TIGHTENING_SHARE,
  budgetState,
} from "../llm/accounting/index.ts";
import { getMetrics, METRIC_NAMES } from "../observability/metrics.ts";

export type RiskSeverity = "warn" | "critical";

export interface RiskSignal {
  kind: string;
  severity: RiskSeverity;
  headline: string;
  detail: string;
  metric: string;
  value: number;
  threshold: number;
}

const SEVERITY_RANK: Record<RiskSeverity, number> = { warn: 1, critical: 2 };

function sortBySeverity(a: RiskSignal, b: RiskSignal): number {
  const bySev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (bySev !== 0) return bySev;
  const aOver = a.threshold > 0 ? a.value / a.threshold : a.value;
  const bOver = b.threshold > 0 ? b.value / b.threshold : b.value;
  return bOver - aOver;
}

export interface RiskInputs {
  monthTokens?: number;
  monthBudget?: number | null;
}

export function computeRiskSignals(inputs: RiskInputs = {}): RiskSignal[] {
  let predictive: Config["observability"]["predictive"];
  try {
    predictive = getConfig().observability.predictive;
  } catch {
    return [];
  }
  const reg = getMetrics();
  const signals: RiskSignal[] = [];

  const poolTotal = reg.gaugeSum(METRIC_NAMES.DB_POOL_TOTAL_CONNECTIONS);
  const poolIdle = reg.gaugeSum(METRIC_NAMES.DB_POOL_IDLE_CONNECTIONS);
  const { monthTokens, monthBudget } = inputs;
  const state =
    typeof monthTokens === "number" && typeof monthBudget === "number"
      ? budgetState(monthTokens, monthBudget)
      : null;
  if (typeof monthTokens === "number" && typeof monthBudget === "number" && state) {
    const usedPct = Math.floor((monthTokens / monthBudget) * 100);
    if (state !== "ample") {
      const critical = state === "critical";
      signals.push({
        kind: "token_budget",
        severity: critical ? "critical" : "warn",
        headline: critical
          ? `Token allowance ${usedPct}% spent`
          : `Token allowance ${usedPct}% spent this month`,
        detail: critical
          ? "Model calls start being refused when it runs out, and a refused scheduled run looks like a broken workflow. Raise the monthly cap or let the month roll over."
          : "Consumption is past three quarters of the monthly cap with the month still running. Worth deciding now whether to raise it.",
        metric: METRIC_NAMES.LLM_TOKENS_TOTAL,
        value: usedPct,
        threshold: (critical ? BUDGET_CRITICAL_SHARE : BUDGET_TIGHTENING_SHARE) * 100,
      });
    }
  }

  const poolWaiting = reg.gaugeSum(METRIC_NAMES.DB_POOL_SUSTAINED_WAITING_CONNECTIONS);
  if (poolTotal > 0) {
    const inUsePct = ((poolTotal - poolIdle) / poolTotal) * 100;
    if (poolWaiting > 0 || inUsePct >= predictive.pool_saturation_pct) {
      const critical = poolWaiting > 0;
      signals.push({
        kind: "pool_saturation",
        severity: critical ? "critical" : "warn",
        headline: critical
          ? `${poolWaiting} client${poolWaiting === 1 ? "" : "s"} waiting on a Postgres connection`
          : `Postgres pool ${Math.round(inUsePct)}% in use`,
        detail: critical
          ? "The pool stayed exhausted for at least 15 seconds — queries are queuing. Expect step timeouts; raise the pool size or shed scheduled load."
          : `In-use connections crossed the ${predictive.pool_saturation_pct}% saturation line. Headroom is shrinking before peak.`,
        metric: critical
          ? METRIC_NAMES.DB_POOL_SUSTAINED_WAITING_CONNECTIONS
          : METRIC_NAMES.DB_POOL_TOTAL_CONNECTIONS,
        value: critical ? poolWaiting : Math.round(inUsePct),
        threshold: critical ? 0 : predictive.pool_saturation_pct,
      });
    }
  }

  const dlqDepth = reg.gaugeSum(METRIC_NAMES.DLQ_JOB_COUNT);
  if (dlqDepth >= predictive.dlq_critical_depth) {
    signals.push({
      kind: "dlq_growth",
      severity: "critical",
      headline: `${dlqDepth} job${dlqDepth === 1 ? "" : "s"} parked in a dead-letter queue`,
      detail:
        "A worker is failing every retry for some payload class. Inspect the *.dlq queue; these jobs will never drain on their own.",
      metric: METRIC_NAMES.DLQ_JOB_COUNT,
      value: dlqDepth,
      threshold: predictive.dlq_critical_depth,
    });
  }

  const retryRate = reg.gaugeSum(METRIC_NAMES.DB_TRANSIENT_RETRY_RATE_PER_MIN);
  if (retryRate >= predictive.transient_retry_rate) {
    signals.push({
      kind: "transient_retry",
      severity: "warn",
      headline: `Postgres is flapping — ${retryRate.toFixed(1)} transient retries/min`,
      detail:
        "Transient connection/serialization retries are climbing. A pass is one bad window from exhausting its tries; check Postgres health and network.",
      metric: METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL,
      value: Math.round(retryRate * 10) / 10,
      threshold: predictive.transient_retry_rate,
    });
  }

  const connectorTotal = reg.counterSum(METRIC_NAMES.CONNECTOR_CALL_TOTAL);
  if (connectorTotal > 0) {
    const unhealthy = reg.counterSumWhere(
      METRIC_NAMES.CONNECTOR_CALL_TOTAL,
      (l) => l.health !== "ok",
    );
    const unhealthyPct = (unhealthy / connectorTotal) * 100;
    if (unhealthyPct >= predictive.connector_unhealthy_pct) {
      signals.push({
        kind: "connector_unhealthy",
        severity: "warn",
        headline: `${Math.round(unhealthyPct)}% of connector calls are returning unhealthy`,
        detail:
          "A rising non-ok share (auth_failed / endpoint_gone / deprecated / rate_limited) is connector drift. Re-probe the connectors and review pending patch candidates.",
        metric: METRIC_NAMES.CONNECTOR_CALL_TOTAL,
        value: Math.round(unhealthyPct),
        threshold: predictive.connector_unhealthy_pct,
      });
    }
  }

  const llmCalls = reg.histogramCount(METRIC_NAMES.LLM_CALL_DURATION_MS);
  if (llmCalls > 0) {
    const fallbacks = reg.counterSum(METRIC_NAMES.LLM_FALLBACK_INVOCATIONS_TOTAL);
    const fallbackPct = (fallbacks / llmCalls) * 100;
    if (fallbackPct >= predictive.llm_fallback_pct) {
      signals.push({
        kind: "llm_fallback",
        severity: "warn",
        headline: `${Math.round(fallbackPct)}% of LLM calls fell back to the secondary model`,
        detail:
          "The primary model is rejecting calls (rate_limit / overloaded / context_length). Latency and cost are up; check provider status and token budgets.",
        metric: METRIC_NAMES.LLM_FALLBACK_INVOCATIONS_TOTAL,
        value: Math.round(fallbackPct),
        threshold: predictive.llm_fallback_pct,
      });
    }
  }

  const rssHighWater = reg.gaugeMax(METRIC_NAMES.PROCESS_MEMORY_RSS_HIGH_WATER_BYTES);
  const hostCap = hostMemoryCapBytes();
  if (rssHighWater > 0 && hostCap > 0) {
    const fraction = rssHighWater / hostCap;
    if (fraction >= predictive.memory_cap_fraction) {
      signals.push({
        kind: "memory_high_water",
        severity: "critical",
        headline: `Engine RSS peaked at ${Math.round(fraction * 100)}% of host memory`,
        detail:
          "A memory transient is approaching the host cap. Past this line the cgroup throttles and turns get dead-lettered — shed concurrency or raise the cap.",
        metric: METRIC_NAMES.PROCESS_MEMORY_RSS_HIGH_WATER_BYTES,
        value: Math.round(fraction * 100) / 100,
        threshold: predictive.memory_cap_fraction,
      });
    }
  }

  return signals.sort(sortBySeverity);
}

function hostMemoryCapBytes(): number {
  try {
    return totalmem();
  } catch {
    return 0;
  }
}

export function topRisk(signals: RiskSignal[]): RiskSignal | null {
  return signals.length > 0 ? (signals[0] as RiskSignal) : null;
}

export const SHARED_RISK_KINDS: ReadonlySet<string> = new Set(["dlq_growth", "token_budget"]);

export function riskEdgeKey(kind: string, instance: string): string {
  return SHARED_RISK_KINDS.has(kind) ? kind : `${kind}@${instance}`;
}

function kindOfEdgeKey(key: string): string {
  const at = key.indexOf("@");
  return at < 0 ? key : key.slice(0, at);
}

export interface RiskEdges {
  raised: RiskSignal[];
  cleared: string[];
}

export async function takeRiskEdges(
  db: Executor,
  signals: RiskSignal[],
  instance: string,
): Promise<RiskEdges> {
  const byKey = new Map(signals.map((s) => [riskEdgeKey(s.kind, instance), s]));
  const nowCriticalKeys = [
    ...new Set(
      signals.filter((s) => s.severity === "critical").map((s) => riskEdgeKey(s.kind, instance)),
    ),
  ];

  let raisedKeys: string[] = [];
  if (nowCriticalKeys.length > 0) {
    const rows = await db
      .insert(riskSignalEdges)
      .values(nowCriticalKeys.map((kind) => ({ kind, active: true })))
      .onConflictDoUpdate({
        target: riskSignalEdges.kind,
        set: { active: true, updated_at: sql`now()` },
        setWhere: eq(riskSignalEdges.active, false),
      })
      .returning({ kind: riskSignalEdges.kind });
    raisedKeys = rows.map((r) => r.kind);
  }

  const owned = or(
    inArray(riskSignalEdges.kind, [...SHARED_RISK_KINDS]),
    like(riskSignalEdges.kind, `%@${instance}`),
  );
  const clearedRows = await db
    .update(riskSignalEdges)
    .set({ active: false, updated_at: sql`now()` })
    .where(
      and(
        eq(riskSignalEdges.active, true),
        owned,
        nowCriticalKeys.length > 0 ? notInArray(riskSignalEdges.kind, nowCriticalKeys) : undefined,
      ),
    )
    .returning({ kind: riskSignalEdges.kind });

  const raised = raisedKeys
    .map((k) => byKey.get(k))
    .filter((s): s is RiskSignal => s !== undefined);
  return { raised, cleared: clearedRows.map((r) => kindOfEdgeKey(r.kind)) };
}

export async function _resetRiskSignalEdgesForTests(db: Executor): Promise<void> {
  await db.delete(riskSignalEdges);
}
