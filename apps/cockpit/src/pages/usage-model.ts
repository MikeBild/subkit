import { auditHref, connectorsHref, runsHref } from "@/app/links";

export interface UsageRow {
  date: string;
  executions: number;
  average_duration_ms: number | null;
  p95_duration_ms: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The windows the operations block can be read over. The engine takes any
 * `from` within its bucket caps (stats/bucket-window.ts): a day in hours, a
 * week and a month in days.
 */
export const USAGE_WINDOWS = ["24h", "7d", "30d"] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

const WINDOW_SHAPE: Record<UsageWindow, { bucket: "hour" | "day"; hours: number }> = {
  "24h": { bucket: "hour", hours: 24 },
  "7d": { bucket: "day", hours: 7 * 24 },
  "30d": { bucket: "day", hours: 30 * 24 },
};

/** A window as the stats routes take it: its bucket and its start. */
function windowQuery(window: UsageWindow, now: Date): string {
  const shape = WINDOW_SHAPE[window];
  const from = new Date(now.getTime() - shape.hours * 3_600_000);
  return `bucket=${shape.bucket}&from=${encodeURIComponent(from.toISOString())}`;
}

/** The runs over one window. The engine rejects a call without a window. */
export function usageStatsEndpoint(window: UsageWindow = "30d", now = new Date()): string {
  return `/v1/stats/executions?${windowQuery(window, now)}`;
}

/**
 * The audit verbs a decided repair leaves: approved by a person, applied on
 * its own, or rejected. The repair rate is computed over exactly these, and
 * its link opens exactly these — the number and the list it leads to are the
 * same rows (operator/operational-overview.ts, DECIDED_REPAIRS_PATH).
 */
export const DECIDED_REPAIR_ACTIONS = [
  "patch_candidate.approved",
  "patch_candidate.auto_applied",
  "patch_candidate.rejected",
] as const;
const APPLIED_REPAIR_ACTIONS = new Set<string>([
  "patch_candidate.approved",
  "patch_candidate.auto_applied",
]);

/** The repair decisions over one window, counted per verb by the engine. */
export function repairStatsEndpoint(window: UsageWindow = "30d", now = new Date()): string {
  return `/v1/stats/events?class=self_healing&group_by=action&${windowQuery(window, now)}`;
}

export interface RepairTotals {
  decided: number;
  applied: number;
}

/** The decided and the applied repairs of the window, from the per-verb groups. */
export function repairTotals(envelope: unknown): RepairTotals | null {
  if (!isRecord(envelope) || !Array.isArray(envelope.groups)) return null;
  let decided = 0;
  let applied = 0;
  for (const group of envelope.groups) {
    if (!isRecord(group) || !isRecord(group.key) || !isRecord(group.totals)) continue;
    const action = group.key.action;
    if (typeof action !== "string") continue;
    if (!(DECIDED_REPAIR_ACTIONS as readonly string[]).includes(action)) continue;
    const calls = isRecord(group.totals.calls) ? numberOrNull(group.totals.calls.total) : null;
    decided += calls ?? 0;
    if (APPLIED_REPAIR_ACTIONS.has(action)) applied += calls ?? 0;
  }
  return { decided, applied };
}

/**
 * The connector counts the health figure is made of. Both are the engine's
 * own totals: the enabled connectors, and the ones among them that count
 * against health (`GET /v1/connectors?health=not_ok`) — the list the figure
 * links to, so the number and the list cannot disagree.
 */
export const CONNECTORS_ENABLED_ENDPOINT = "/v1/connectors?enabled=true&limit=1";
export const CONNECTORS_NOT_OK_ENDPOINT = "/v1/connectors?health=not_ok&limit=1";

export function listTotal(envelope: unknown): number | null {
  return isRecord(envelope) ? numberOrNull(envelope.total) : null;
}

export type OperatingFigureId = "runs" | "successRate" | "connectorHealth" | "repairRate";

export interface OperatingFigure {
  id: OperatingFigureId;
  /** The raw figure: a count for runs, a whole percentage for the rates. */
  value: number;
  /** Where the value leads — a list narrowed to what it counts. Null where the reader may not open it. */
  href: string | null;
  /** True for a state measured now rather than over the window. */
  current: boolean;
}

/**
 * The operations figures, in reading order, each with the one list it opens.
 *
 * A figure that has nothing to say is absent, not a nought: no runs in the
 * window means no run count and no success rate; no enabled connector means
 * no connector health; no decided repair means no repair rate. A tile reading
 * 0 beside nothing measured is the zero that means "not measured".
 *
 * Nothing here is a task — what needs someone is on Heute, and this block
 * repeats none of it.
 */
export function operatingFigures(input: {
  totals: Pick<UsageTotals, "executions" | "successRatePercent">;
  connectors: { enabled: number | null; notOk: number | null } | null;
  repairs: RepairTotals | null;
  canOpen: { runs: boolean; connectors: boolean; audit: boolean };
}): OperatingFigure[] {
  const figures: OperatingFigure[] = [];
  const { totals, connectors, repairs, canOpen } = input;
  if (totals.executions !== null && totals.executions > 0) {
    figures.push({
      id: "runs",
      value: totals.executions,
      href: canOpen.runs ? runsHref() : null,
      current: false,
    });
    if (totals.successRatePercent !== null)
      figures.push({
        id: "successRate",
        value: totals.successRatePercent,
        href: canOpen.runs ? runsHref({ status: "failed" }) : null,
        current: false,
      });
  }
  if (
    connectors &&
    connectors.enabled !== null &&
    connectors.enabled > 0 &&
    connectors.notOk !== null
  ) {
    const healthy = Math.max(connectors.enabled - connectors.notOk, 0);
    figures.push({
      id: "connectorHealth",
      value: Math.round((healthy / connectors.enabled) * 100),
      href: canOpen.connectors ? connectorsHref({ health: "not_ok" }) : null,
      current: true,
    });
  }
  if (repairs && repairs.decided > 0)
    figures.push({
      id: "repairRate",
      value: Math.round((repairs.applied / repairs.decided) * 100),
      href: canOpen.audit ? auditHref({ scope: "all", actions: DECIDED_REPAIR_ACTIONS }) : null,
      current: false,
    });
  return figures;
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
 * units reconcile. The WINDOWS do not: these rows cover the last thirty days
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
