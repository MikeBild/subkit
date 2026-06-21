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
import { getConfig } from "../config/loader.ts";
import type { Config } from "../config/schema.ts";
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
export function computeRiskSignals(): RiskSignal[] {
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

  // 3. Transient-DB-retry rate. Counter is process-cumulative; we chart it
  //    per minute of uptime against the configured per-minute rate.
  const transientRetries = reg.counterSum(METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL);
  const uptimeMin = Math.max(process.uptime() / 60, 1);
  const retryRate = transientRetries / uptimeMin;
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

// Process-scoped edge tracker for critical-risk auditing. The risk signals
// describe shared host infrastructure (one Postgres pool, one set of DLQs,
// one engine RSS), so a standing critical must be audited ONCE when it
// appears — not on every digest read, and not once per reading tenant. The
// builder runs on every MCP connect / resource read / REPL start / status
// call, so auditing inside it would flood `audit_log` with duplicate rows
// for the same condition. Key by signal `kind`; emit only on the false→true
// edge; clear on recovery so the next occurrence re-fires.
//
// Caveat (multi-replica): the tracker is per-process. In an N-replica deploy
// the same standing critical can audit up to N× per edge — once per replica
// that first reads the digest. Acceptable for now (audit volume is tiny); a
// Postgres-side claim (advisory lock / INSERT…ON CONFLICT on a
// `risk_signal_edge` table keyed by (kind, window)) is the HA hardening if
// SIEM dedup ever needs exactly-once.
const criticalActiveByKind = new Map<string, boolean>();

export interface RiskEdges {
  /** Signals that NEWLY crossed into `critical` since the last call. */
  raised: RiskSignal[];
  /** Kinds that RECOVERED out of `critical` since the last call. */
  cleared: string[];
}

/**
 * Return the critical-state EDGES since the last call, updating the
 * process-scoped tracker. The caller audits RISK_SIGNAL_RAISED on each
 * `raised` and RISK_SIGNAL_CLEARED on each `cleared` (under the system tenant —
 * host-scoped signals), so SIEM gets both edges for MTTR. A persistent
 * critical produces neither edge on subsequent reads; a recovered-then-
 * recurring one re-fires.
 */
export function takeRiskEdges(signals: RiskSignal[]): RiskEdges {
  const nowCritical = new Set(signals.filter((s) => s.severity === "critical").map((s) => s.kind));
  const raised: RiskSignal[] = [];
  for (const s of signals) {
    if (s.severity === "critical" && !criticalActiveByKind.get(s.kind)) raised.push(s);
  }
  const cleared: string[] = [];
  for (const [kind, active] of criticalActiveByKind) {
    if (active && !nowCritical.has(kind)) {
      cleared.push(kind);
      criticalActiveByKind.set(kind, false);
    }
  }
  for (const kind of nowCritical) criticalActiveByKind.set(kind, true);
  return { raised, cleared };
}

/** Test-only: clear the critical-edge tracker between cases. */
export function _resetCriticalEdgeTrackerForTests(): void {
  criticalActiveByKind.clear();
}
