// Predictive-maintenance risk signals — the leading-indicator half of the
// operator health digest.
//
// The failure groups in `health-digest.ts` are LAGGING: a run already
// failed. These signals are LEADING: they read the Phase-2 process gauges
// and counters (pool saturation, DLQ depth, transient-DB-retry rate,
// connector-call health mix, LLM fallback fraction, RSS high-water) against
// the operator-tuned thresholds in `observability.predictive` and flag the
// ones trending toward an incident BEFORE a workflow fails.
//
// Scope note: the metrics registry is process-scoped, not tenant-scoped —
// the Postgres pool, the DLQs, and the engine RSS are shared infrastructure.
// So these signals describe the engine the tenant is running on, not the
// tenant's own workflows. That's the right altitude for an operator digest:
// "your runs are fine, but the host is about to OOM" is exactly the warning
// that the lagging failure groups can never give you in time.

import { totalmem } from "node:os";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { getConfig } from "../config/loader.ts";
import type { Config } from "../config/schema.ts";
import type { Executor } from "../db/client.ts";
import { riskSignalEdges } from "../db/schema/index.ts";
import { getMetrics, METRIC_NAMES } from "../observability/metrics.ts";

// Only "warn" and "critical" are produced today — a signal either trends
// toward the cliff (warn) or is over it (critical). No "info" tier until a
// producer needs one; keeping it would be dead surface in the generated type.
export type RiskSeverity = "warn" | "critical";

export interface RiskSignal {
  /** Stable machine kind — e.g. "pool_saturation", "llm_fallback". */
  kind: string;
  severity: RiskSeverity;
  /** Outcome-first one-liner for the chat/banner surface. */
  headline: string;
  /** The "why it matters / what to do" sentence. */
  detail: string;
  /** The underlying metric name the signal reads. */
  metric: string;
  /** Observed value (the same unit the threshold is in). */
  value: number;
  /** The configured threshold the value was compared against. */
  threshold: number;
}

const SEVERITY_RANK: Record<RiskSeverity, number> = { warn: 1, critical: 2 };

/** Highest-severity-first, then by how far past threshold (worst first). */
function sortBySeverity(a: RiskSignal, b: RiskSignal): number {
  const bySev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (bySev !== 0) return bySev;
  // Both relative to their own threshold so unlike units stay comparable.
  const aOver = a.threshold > 0 ? a.value / a.threshold : a.value;
  const bOver = b.threshold > 0 ? b.value / b.threshold : b.value;
  return bOver - aOver;
}

/**
 * Compute the current leading-indicator risk signals from the live metrics
 * registry against the configured predictive thresholds. Pure read — never
 * mutates a gauge, never throws (a config-read failure collapses to an empty
 * list so the digest still renders). Sorted highest-severity-first.
 */
/**
 * What the caller knows that the metrics registry cannot.
 *
 * The month's token consumption is a database sum against a configured cap.
 * `llm_tokens_total` is a COUNTER since process start: it resets on restart
 * and knows nothing about a calendar month, so reading it here would produce
 * a signal that quietly lies after every deploy. The digest already holds
 * both figures; it passes them in rather than this function guessing.
 */
export interface RiskInputs {
  /** Weighted tokens consumed this calendar month. */
  monthTokens?: number;
  /** The cap in force, or null when nothing bounds the workspace. */
  monthBudget?: number | null;
}

export function computeRiskSignals(inputs: RiskInputs = {}): RiskSignal[] {
  let predictive: Config["observability"]["predictive"];
  try {
    predictive = getConfig().observability.predictive;
  } catch {
    // Config not loaded (unit harness) — no thresholds, no signals.
    return [];
  }
  const reg = getMetrics();
  const signals: RiskSignal[] = [];

  // 1. Postgres-pool saturation. The leading signal is `waiting > 0`; the
  //    in-use percentage escalates it. Total 0 → pool not yet sampled.
  const poolTotal = reg.gaugeSum(METRIC_NAMES.DB_POOL_TOTAL_CONNECTIONS);
  const poolIdle = reg.gaugeSum(METRIC_NAMES.DB_POOL_IDLE_CONNECTIONS);
  // The month's allowance, when the caller supplied both halves.
  //
  // This belongs here and NOT in the decisions queue. That queue's grammar is
  // approve or reject — every position carries an id, an action and an audit
  // row — and a budget running low has none of those: there is nothing to
  // approve. §8.5b is explicit that a position with no consequence is not a
  // decision. It is a leading indicator that needs a person and has a next
  // step, which is what a risk signal is.
  //
  // A null cap raises nothing. An unbounded workspace is not at risk of
  // hitting a limit; it is simply unmeasured, and warning about a ceiling
  // that does not exist would be the zero that means "not measured".
  const { monthTokens, monthBudget } = inputs;
  if (typeof monthTokens === "number" && typeof monthBudget === "number" && monthBudget > 0) {
    const usedPct = Math.round((monthTokens / monthBudget) * 100);
    if (usedPct >= 75) {
      const critical = usedPct >= 90;
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
        threshold: critical ? 90 : 75,
      });
    }
  }

  const poolWaiting = reg.gaugeSum(METRIC_NAMES.DB_POOL_WAITING_CONNECTIONS);
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
          ? "The pool is exhausted — queries are queuing. Expect step timeouts; raise the pool size or shed scheduled load."
          : `In-use connections crossed the ${predictive.pool_saturation_pct}% saturation line. Headroom is shrinking before peak.`,
        metric: critical
          ? METRIC_NAMES.DB_POOL_WAITING_CONNECTIONS
          : METRIC_NAMES.DB_POOL_TOTAL_CONNECTIONS,
        value: critical ? poolWaiting : Math.round(inUsePct),
        threshold: critical ? 0 : predictive.pool_saturation_pct,
      });
    }
  }

  // 2. DLQ depth. A point read can't see per-window deltas, so we flag on the
  //    standing parked count: a DLQ at or above the critical-depth threshold
  //    means a worker is failing every attempt for some payload class and the
  //    backlog won't drain on its own.
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

  // 3. Transient-DB-retry rate. Read the WINDOWED per-minute gauge the memory
  //    sampler maintains (retries since the previous 60s tick ÷ elapsed
  //    minutes), not the cumulative total ÷ uptime — a lifetime average would
  //    latch on an old blip (short uptime) or go deaf to a fresh spike (long
  //    uptime). The gauge is a true leading indicator that decays per window.
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

  // 4. Connectors trending unhealthy. The non-`ok` share of connector calls
  //    is the leading drift signal, tuned by its OWN threshold so silencing a
  //    pool alarm doesn't silently move the connector-drift floor.
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

  // 5. LLM fallback fraction. Fallback engagements over total LLM calls. A
  //    rising fraction flags primary-model instability before it surfaces as
  //    user-facing errors. Tuned by its own threshold (see connector note).
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

  // 6. RSS high-water vs the host memory cap. The high-water gauge is
  //    bytes; the host cap is the total physical memory. Crossing
  //    `memory_cap_fraction` of it is the OOM-risk warning — production has
  //    seen multi-GB transients drive MemoryHigh throttle → swap thrash →
  //    dead-lettered turns (project_engine_memory_worker_expired).
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

/** Total physical host memory in bytes, the denominator for the RSS
 *  high-water OOM-risk fraction. Best-effort: returns 0 when `os` can't
 *  report it so the memory signal simply doesn't fire. */
function hostMemoryCapBytes(): number {
  try {
    return totalmem();
  } catch {
    return 0;
  }
}

/** The single highest-severity signal, or null when all clear. Used to fold
 *  risk into the digest headline. */
export function topRisk(signals: RiskSignal[]): RiskSignal | null {
  return signals.length > 0 ? (signals[0] as RiskSignal) : null;
}

// Cross-replica edge tracker for critical-risk auditing. The risk signals
// describe shared host infrastructure (one Postgres pool, one set of DLQs,
// one engine RSS), so a standing critical must be audited EXACTLY ONCE per
// false→true edge — not on every digest read, not once per reading tenant,
// and not once per replica. The builder runs on every MCP connect / resource
// read / REPL start / status call, so auditing inside it would otherwise flood
// `audit_log`. Edge state lives in the shared `risk_signal_edges` table keyed
// by signal `kind`; every replica claims an edge through an atomic
// INSERT…ON CONFLICT…WHERE CAS so exactly one wins. Recovery clears the row so
// the next occurrence re-fires.
//
// (Previously a per-process Map — correct within one process, but an N-replica
// deploy duplicated each edge audit up to N×.)

export interface RiskEdges {
  /** Signals that NEWLY crossed into `critical` since the last call. */
  raised: RiskSignal[];
  /** Kinds that RECOVERED out of `critical` since the last call. */
  cleared: string[];
}

/**
 * Claim and return the critical-state EDGES since the last call, transitioning
 * the shared `risk_signal_edges` table. The caller audits RISK_SIGNAL_RAISED on
 * each `raised` and RISK_SIGNAL_CLEARED on each `cleared` (under the system
 * tenant — host-scoped signals), so SIEM gets both edges for MTTR. The CAS
 * RETURNING clause guarantees exactly one replica observes each edge: a
 * persistent critical yields neither edge on subsequent reads (on any replica),
 * and a recovered-then-recurring one re-fires once.
 */
export async function takeRiskEdges(db: Executor, signals: RiskSignal[]): Promise<RiskEdges> {
  const bySignal = new Map(signals.map((s) => [s.kind, s]));
  const nowCriticalKinds = [
    ...new Set(signals.filter((s) => s.severity === "critical").map((s) => s.kind)),
  ];

  // Claim the false→true edge for every currently-critical kind. The
  // conflicting set-where returns a kind only when THIS call inserted it fresh
  // or flipped it false→true — a row already `active=true` fails the where and
  // is not returned, so a standing critical never re-audits and exactly one
  // replica wins the edge.
  let raisedKinds: string[] = [];
  if (nowCriticalKinds.length > 0) {
    const rows = await db
      .insert(riskSignalEdges)
      .values(nowCriticalKinds.map((kind) => ({ kind, active: true })))
      .onConflictDoUpdate({
        target: riskSignalEdges.kind,
        set: { active: true, updated_at: sql`now()` },
        setWhere: eq(riskSignalEdges.active, false),
      })
      .returning({ kind: riskSignalEdges.kind });
    raisedKinds = rows.map((r) => r.kind);
  }

  // Clear every still-active kind that is no longer critical, RETURNING the
  // kinds THIS call transitioned true→false (one replica wins each).
  const clearedRows = await db
    .update(riskSignalEdges)
    .set({ active: false, updated_at: sql`now()` })
    .where(
      nowCriticalKinds.length > 0
        ? and(eq(riskSignalEdges.active, true), notInArray(riskSignalEdges.kind, nowCriticalKinds))
        : eq(riskSignalEdges.active, true),
    )
    .returning({ kind: riskSignalEdges.kind });
  const cleared = clearedRows.map((r) => r.kind);

  const raised = raisedKinds
    .map((k) => bySignal.get(k))
    .filter((s): s is RiskSignal => s !== undefined);
  return { raised, cleared };
}

/** Test-only: clear the shared risk-signal edge table between cases. */
export async function _resetRiskSignalEdgesForTests(db: Executor): Promise<void> {
  await db.delete(riskSignalEdges);
}
