export interface UsageRow {
  date: string;
  executions: number;
  average_duration_ms: number | null;
  p95_duration_ms: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

export interface ConsumptionRow {
  /** The workflow, purpose, user or model this row is about. Empty when none. */
  key: string;
  /** True when the engine could not attribute these calls along this axis. */
  unattributed: boolean;
  calls: number;
  tokens: number;
  /** This row's share of the window, 0–1. `null` when the total is zero. */
  share: number | null;
}

/**
 * One row per group, largest first.
 *
 * `total` is the cache-weighted figure the budget is also measured in, so the
 * units reconcile. The WINDOWS do not: these rows cover the chosen window
 * and the remaining-budget line covers the calendar month. Every surface that
 * shows both must name which is which — an earlier version of this comment
 * claimed they added up to the same number, which is false on any day but the
 * last of a month.
 */
export function consumptionRows(envelope: unknown, axis: ConsumptionAxis): ConsumptionRow[] {
  const groups = isRecord(envelope) && Array.isArray(envelope.groups) ? envelope.groups : [];
  const rows = groups.flatMap((group): ConsumptionRow[] => {
    if (!isRecord(group)) return [];
    // `key` is a map of dimension to value — `{ workflow: "ga4-daily-report" }`
    // — because a caller may group by two dimensions at once. Reading it as a
    // string dropped every group and left a page that had measured forty
    // million tokens saying "no model calls in this window".
    //
    // The unit test agreed with the mistake: it fed a bare string, matching
    // the assumption rather than the published contract, and stayed green
    // while nothing could ever render.
    const keyed = isRecord(group.key) ? group.key[axis] : undefined;
    if (typeof keyed !== "string") return [];
    const totals = isRecord(group.totals) ? group.totals : {};
    const tokens = isRecord(totals.tokens) ? totals.tokens : {};
    // PER GROUP `calls` is a plain number. Only the envelope-level total is
    // `{ total, by_result }` — two shapes at two levels, and reading the outer
    // one here made every row report nought calls beside millions of tokens.
    // Read from `stats/schemas.ts`, not from memory: this is the third time
    // this function assumed a shape the contract does not have.
    const callsValue = numberOrNull(totals.calls) ?? 0;
    return [
      {
        key: keyed,
        // An empty dimension is a real answer, not a missing row.
        //
        // `llm_usage` carries no workflow: the attribution comes from a join
        // on `executions`, so every call without a run — conversations,
        // self-healing, discovery — has no workflow and arrives with an empty
        // key. Dropping those rows made a page about consumption report "no
        // model calls in this window" beside a header naming forty million
        // tokens, because on this installation nearly all of it is chat.
        //
        // "Cannot be attributed" and "did not happen" are different facts.
        unattributed: keyed.length === 0,
        calls: callsValue,
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
  /** The engine's own word for the month (`/v1/status` `monthly_budget_state`). */
  state?: "ample" | "tightening" | "critical" | null;
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
  const state = s.monthly_budget_state;
  return {
    ...(state === "ample" || state === "tightening" || state === "critical" || state === null
      ? { state }
      : {}),
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
 *
 * The engine decides: `/v1/status` sends `monthly_budget_state`, the same word
 * the attention list, MCP `get_token_budget` and `sk health` use, measured on
 * the exact share (75 %, 90 %). The cockpit computed its own on a rounded
 * percentage, so 89.6 % was critical here and tightening everywhere else. The
 * local rule remains only for an engine that does not send the field.
 */
export function budgetPressure(summary: BudgetSummary): "ample" | "tightening" | "critical" | null {
  if (summary.state !== undefined) return summary.state;
  const { usedTokens, budgetTokens } = summary;
  if (budgetTokens === null || budgetTokens <= 0 || usedTokens === null) return null;
  const share = usedTokens / budgetTokens;
  if (share >= 0.9) return "critical";
  if (share >= 0.75) return "tightening";
  return "ample";
}

/**
 * The month's spend as a whole percentage, rounded DOWN so the number never
 * crosses a threshold the state has not: 89.6 % reads "89 %" beside "Wird
 * knapp", not "90 %". `null` when nothing bounds the workspace. Not capped at
 * 100: an overspent month says so.
 */
export function budgetPercent(summary: BudgetSummary): number | null {
  const { usedTokens, budgetTokens } = summary;
  if (budgetTokens === null || budgetTokens <= 0 || usedTokens === null) return null;
  return Math.floor((usedTokens / budgetTokens) * 100);
}

export interface WindowCost {
  amount: number;
  currency: string;
  /** Models neither the built-in catalog nor an override priced. Named, never folded into the amount. */
  unpricedModels: string[];
  unpricedCalls: number;
}

/**
 * The models the window's cost could not price, by name.
 *
 * Read on its own because `windowCost` is `null` exactly when nothing was
 * priced — and that is when a reader most needs to know which models lack a
 * price. SubKit ships list prices for the models it uses, so an unpriced model
 * is a specific one, not "no prices at all".
 */
export function unpricedModels(envelope: unknown): string[] {
  const cost = isRecord(envelope) && isRecord(envelope.cost) ? envelope.cost : null;
  if (!cost || !Array.isArray(cost.unpriced_models)) return [];
  return cost.unpriced_models.filter((m): m is string => typeof m === "string");
}

/**
 * The window's money, or nothing.
 *
 * `null` when no call in the window had a price: an amount of zero beside a month
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

/**
 * A workflow id on the usage page, resolved to what a reader can be told.
 *
 * `status` is the HTTP status of the failed lookup, `0` for a failure without
 * one, `null` while there is none. Only a 404 says the workflow is gone.
 */
export type WorkflowNameLookup =
  | { kind: "named"; name: string }
  | { kind: "gone" }
  | { kind: "unreadable" }
  | { kind: "pending" };

export function workflowNameLookup(
  data: { name?: string | null; slug?: string | null } | undefined,
  status: number | null,
): WorkflowNameLookup {
  const name = data?.name?.trim() || data?.slug?.trim();
  if (name) return { kind: "named", name };
  if (status === 404) return { kind: "gone" };
  if (status !== null || data !== undefined) return { kind: "unreadable" };
  return { kind: "pending" };
}
