export interface UsageRow {
  date: string;
  executions: number;
  average_duration_ms: number | null;
  p95_duration_ms: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The 30-day window the usage page reads. The engine rejects a call without it. */
export function usageStatsEndpoint(now = new Date()): string {
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 30);
  return `/v1/stats/executions?bucket=day&from=${encodeURIComponent(from.toISOString())}`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Flattens the grouped bucket envelope into one row per day.
 *
 * A bucket that carries no duration keeps `null`, not `0` — a day nobody
 * measured and a day that measured zero are different facts (CUI-SEV-2).
 */
export function usageRows(envelope: unknown): UsageRow[] {
  const groups = isRecord(envelope) && Array.isArray(envelope.groups) ? envelope.groups : [];
  return groups.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.buckets)) return [];
    return group.buckets.flatMap((bucket): UsageRow[] => {
      if (!isRecord(bucket) || typeof bucket.ts !== "string") return [];
      const duration = isRecord(bucket.duration_ms) ? bucket.duration_ms : {};
      return [
        {
          date: bucket.ts,
          executions: typeof bucket.executions === "number" ? bucket.executions : 0,
          average_duration_ms: numberOrNull(duration.avg),
          p95_duration_ms: numberOrNull(duration.p95),
        },
      ];
    });
  });
}

export interface UsageTotals {
  executions: number | null;
  averageDurationMs: number | null;
  p95DurationMs: number | null;
  successRatePercent: number | null;
}

const SUCCESS_STATUSES = ["completed", "succeeded", "success"] as const;

/** The four headline numbers. Each one is `null` when the engine did not send it. */
export function usageTotals(envelope: unknown): UsageTotals {
  const totals = isRecord(envelope) && isRecord(envelope.totals) ? envelope.totals : {};
  const executionsEnvelope = isRecord(totals.executions) ? totals.executions : {};
  const durations = isRecord(totals.duration_ms) ? totals.duration_ms : {};
  const count = numberOrNull(executionsEnvelope.count);
  const byStatus = isRecord(executionsEnvelope.by_status) ? executionsEnvelope.by_status : null;
  const succeeded = byStatus
    ? SUCCESS_STATUSES.reduce(
        (total, key) => total + (typeof byStatus[key] === "number" ? byStatus[key] : 0),
        0,
      )
    : null;
  return {
    executions: count,
    averageDurationMs: numberOrNull(durations.avg),
    p95DurationMs: numberOrNull(durations.p95),
    successRatePercent:
      count !== null && count > 0 && succeeded !== null
        ? Math.round((succeeded / count) * 100)
        : null,
  };
}

export function formatDurationMs(value: number | null): string {
  if (value === null) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

// ---------------------------------------------------------------------------
// Consumption — what the workspace spent, and what it has left
//
// The page called "Usage" measured duration and success rate and nothing else.
// The engine has measured tokens per model, per purpose, per user and per
// workflow the whole time, and serves them on `/v1/stats/llm`; the cap and the
// remainder sit on `/v1/status`. No cockpit screen asked for either, so the
// only surface that could answer "what does this cost us" was the terminal.
// ---------------------------------------------------------------------------

/** The axes a reader can break consumption down by, in the order offered. */
export const CONSUMPTION_AXES = ["workflow", "flow", "user", "model"] as const;
export type ConsumptionAxis = (typeof CONSUMPTION_AXES)[number];

/** Token consumption over the same window, grouped along one axis. */
export function llmStatsEndpoint(axis: ConsumptionAxis, now = new Date()): string {
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 30);
  return `/v1/stats/llm?bucket=day&from=${encodeURIComponent(from.toISOString())}&group_by=${axis}`;
}

export interface ConsumptionRow {
  /** The workflow, purpose, user or model this row is about. */
  key: string;
  calls: number;
  tokens: number;
  /** This row's share of the window, 0–1. `null` when the total is zero. */
  share: number | null;
}

/**
 * One row per group, largest first.
 *
 * `total` is the cache-weighted figure the budget is measured against, so the
 * shares here add up to the same number the remaining-budget line subtracts
 * from. Using raw prompt tokens instead would produce a breakdown that cannot
 * be reconciled with the headline.
 */
export function consumptionRows(envelope: unknown): ConsumptionRow[] {
  const groups = isRecord(envelope) && Array.isArray(envelope.groups) ? envelope.groups : [];
  const rows = groups.flatMap((group): ConsumptionRow[] => {
    if (!isRecord(group) || typeof group.key !== "string") return [];
    const totals = isRecord(group.totals) ? group.totals : {};
    const tokens = isRecord(totals.tokens) ? totals.tokens : {};
    const callsEnvelope = isRecord(totals.calls) ? totals.calls : {};
    return [
      {
        key: group.key,
        calls: typeof callsEnvelope.total === "number" ? callsEnvelope.total : 0,
        tokens: typeof tokens.total === "number" ? tokens.total : 0,
        share: null,
      },
    ];
  });
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  return rows
    .map((row) => ({ ...row, share: total > 0 ? row.tokens / total : null }))
    .sort((a, b) => b.tokens - a.tokens || (a.key < b.key ? -1 : 1));
}

export interface BudgetSummary {
  usedTokens: number | null;
  budgetTokens: number | null;
  remainingTokens: number | null;
  /** How much of the cap is spent, 0–1. `null` when there is no cap. */
  consumedShare: number | null;
}

/**
 * The month's consumption against the cap.
 *
 * A missing cap is `null`, never `0`: "no cap configured" and "a cap of zero
 * tokens" are different facts, and rendering the first as the second would
 * tell an operator their workspace is exhausted when nothing bounds it.
 */
export function budgetSummary(status: unknown): BudgetSummary {
  const s = isRecord(status) ? status : {};
  const used = numberOrNull(s.tokens_month);
  const budget = numberOrNull(s.monthly_budget_tokens);
  const remaining = numberOrNull(s.remaining_monthly_budget_tokens);
  return {
    usedTokens: used,
    budgetTokens: budget,
    remainingTokens: remaining,
    consumedShare:
      budget !== null && budget > 0 && used !== null ? Math.min(used / budget, 1) : null,
  };
}

/**
 * How close the workspace is to its cap, as something a reader can act on.
 *
 * Deliberately three states and no percentage badge: the number is already on
 * screen, and a second encoding of it would be the duplicate display this
 * cockpit keeps removing. `null` when nothing bounds the workspace — an
 * unbounded installation is not "healthy", it is unmeasured, and saying
 * otherwise is the zero that means "not measured".
 */
export function budgetPressure(summary: BudgetSummary): "ample" | "tightening" | "critical" | null {
  if (summary.consumedShare === null) return null;
  if (summary.consumedShare >= 0.9) return "critical";
  if (summary.consumedShare >= 0.75) return "tightening";
  return "ample";
}

export interface WindowCost {
  amount: number;
  currency: string;
  /** Models the configured rates did not cover. Named, never folded into the amount. */
  unpricedModels: string[];
  unpricedCalls: number;
}

/**
 * The window's money, or nothing.
 *
 * `null` when no rate is configured at all: an amount of zero beside a month
 * that plainly consumed tokens reads as "this was free", which is the most
 * expensive misreading this data can produce. A partial amount — some models
 * priced, some not — IS returned, because `unpricedCalls` travels with it and
 * the surface says so.
 */
export function windowCost(envelope: unknown): WindowCost | null {
  const cost = isRecord(envelope) && isRecord(envelope.cost) ? envelope.cost : null;
  if (!cost) return null;
  const amount = numberOrNull(cost.amount);
  const unpricedCalls = numberOrNull(cost.unpriced_calls) ?? 0;
  const models = Array.isArray(cost.unpriced_models)
    ? cost.unpriced_models.filter((m): m is string => typeof m === "string")
    : [];
  if (amount === null) return null;
  // Nothing priced at all is not a cost of nothing.
  if (amount === 0 && unpricedCalls > 0) return null;
  return {
    amount,
    currency: typeof cost.currency === "string" ? cost.currency : "USD",
    unpricedModels: models,
    unpricedCalls,
  };
}
