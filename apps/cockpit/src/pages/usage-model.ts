function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function runsByWorkflow(envelope: unknown): Map<string, number> {
  const groups = isRecord(envelope) && Array.isArray(envelope.groups) ? envelope.groups : [];
  const runs = new Map<string, number>();
  for (const group of groups) {
    if (!isRecord(group) || !isRecord(group.key) || !isRecord(group.totals)) continue;
    const id = group.key.workflow_id;
    const count = numberOrNull(group.totals.executions);
    if (typeof id === "string" && id && count !== null) runs.set(id, count);
  }
  return runs;
}

export const CONSUMPTION_AXES = ["workflow", "flow", "user", "model"] as const;
export type ConsumptionAxis = (typeof CONSUMPTION_AXES)[number];

export interface ConsumptionRow {
  key: string;
  name?: string;
  unattributed: boolean;
  calls: number;
  tokens: number;
  share: number | null;
  cost: number | null;
}

export function consumptionRows(envelope: unknown, axis: ConsumptionAxis): ConsumptionRow[] {
  const groups = isRecord(envelope) && Array.isArray(envelope.groups) ? envelope.groups : [];
  const rows = groups.flatMap((group): ConsumptionRow[] => {
    if (!isRecord(group)) return [];
    const keyed = isRecord(group.key) ? group.key[axis] : undefined;
    if (typeof keyed !== "string") return [];
    const totals = isRecord(group.totals) ? group.totals : {};
    const tokens = isRecord(totals.tokens) ? totals.tokens : {};
    const callsValue = numberOrNull(totals.calls) ?? 0;
    const priced = isRecord(group.cost) ? group.cost : null;
    const amount = priced ? numberOrNull(priced.amount) : null;
    const unpriced = priced ? (numberOrNull(priced.unpriced_calls) ?? 0) : 0;
    const name = axis === "model" && typeof group.model_name === "string" ? group.model_name : "";
    return [
      {
        key: keyed,
        ...(name ? { name } : {}),
        unattributed: keyed.length === 0,
        calls: callsValue,
        tokens: typeof tokens.total === "number" ? tokens.total : 0,
        share: null,
        cost: amount === null || (amount === 0 && unpriced > 0) ? null : amount,
      },
    ];
  });
  return withShares(rows);
}

function withShares<Row extends { key: string; tokens: number; cost: number | null }>(
  rows: Row[],
): (Row & { share: number | null })[] {
  const priced = rows.length > 0 && rows.every((row) => row.cost !== null);
  const measure = (row: Row): number => (priced ? (row.cost ?? 0) : row.tokens);
  const total = rows.reduce((sum, row) => sum + measure(row), 0);
  return rows
    .map((row) => ({ ...row, share: total > 0 ? measure(row) / total : null }))
    .sort((a, b) => measure(b) - measure(a) || (a.key < b.key ? -1 : 1));
}

export const USAGE_ORIGINS = [
  "chat",
  "authoring",
  "summaries",
  "reviews",
  "knowledge",
  "workflowRuns",
  "other",
] as const;
export type UsageOrigin = (typeof USAGE_ORIGINS)[number];

export const FLOW_ORIGIN: Readonly<Record<string, UsageOrigin>> = {
  converse: "chat",
  suggest_next: "chat",
  generate: "authoring",
  repair: "authoring",
  tool_repair: "authoring",
  critic_authoring: "authoring",
  summarize: "summaries",
  judge: "reviews",
  extract: "knowledge",
  catalog_describe: "knowledge",
  discover: "knowledge",
  workflow_step: "workflowRuns",
};

export function flowOrigin(flow: string): UsageOrigin {
  const known = Object.hasOwn(FLOW_ORIGIN, flow) ? FLOW_ORIGIN[flow] : undefined;
  if (known) return known;
  if (flow.startsWith("critic_")) return "authoring";
  return "other";
}

export interface OriginRow {
  key: UsageOrigin;
  flows: string[];
  calls: number;
  tokens: number;
  share: number | null;
  cost: number | null;
}

export function originRows(envelope: unknown): OriginRow[] {
  const byOrigin = new Map<UsageOrigin, Omit<OriginRow, "share">>();
  for (const row of consumptionRows(envelope, "flow")) {
    const key = flowOrigin(row.key);
    const into = byOrigin.get(key);
    if (!into) {
      byOrigin.set(key, {
        key,
        flows: [row.key],
        calls: row.calls,
        tokens: row.tokens,
        cost: row.cost,
      });
      continue;
    }
    into.flows.push(row.key);
    into.calls += row.calls;
    into.tokens += row.tokens;
    into.cost = into.cost === null || row.cost === null ? null : into.cost + row.cost;
  }
  return withShares([...byOrigin.values()]);
}

export function attributableWorkflowRows(rows: readonly ConsumptionRow[]): ConsumptionRow[] {
  return rows.filter((row) => !row.unattributed);
}

export interface BudgetSummary {
  usedTokens: number | null;
  budgetTokens: number | null;
  remainingTokens: number | null;
  consumedShare: number | null;
  state: "ample" | "tightening" | "critical" | null;
}

export function budgetSummary(status: unknown): BudgetSummary {
  const s = isRecord(status) ? status : {};
  const used = numberOrNull(s.tokens_month);
  const budget = numberOrNull(s.monthly_budget_tokens);
  const remaining = numberOrNull(s.remaining_monthly_budget_tokens);
  const state = s.monthly_budget_state;
  return {
    state: state === "ample" || state === "tightening" || state === "critical" ? state : null,
    usedTokens: used,
    budgetTokens: budget,
    remainingTokens: remaining,
    consumedShare:
      budget !== null && budget > 0 && used !== null ? Math.min(used / budget, 1) : null,
  };
}

export function budgetPressure(summary: BudgetSummary): "ample" | "tightening" | "critical" | null {
  return summary.state;
}

export function budgetPercent(summary: BudgetSummary): number | null {
  const { usedTokens, budgetTokens } = summary;
  if (budgetTokens === null || budgetTokens <= 0 || usedTokens === null) return null;
  return Math.floor((usedTokens / budgetTokens) * 100);
}

export interface WindowCost {
  amount: number;
  currency: string;
  unpricedModels: string[];
  unpricedCalls: number;
}

export function unpricedModels(envelope: unknown): string[] {
  const cost = isRecord(envelope) && isRecord(envelope.cost) ? envelope.cost : null;
  if (!cost || !Array.isArray(cost.unpriced_models)) return [];
  return cost.unpriced_models.filter((m): m is string => typeof m === "string");
}

export function windowCost(envelope: unknown): WindowCost | null {
  const cost = isRecord(envelope) && isRecord(envelope.cost) ? envelope.cost : null;
  if (!cost) return null;
  const amount = numberOrNull(cost.amount);
  const unpricedCalls = numberOrNull(cost.unpriced_calls) ?? 0;
  const models = Array.isArray(cost.unpriced_models)
    ? cost.unpriced_models.filter((m): m is string => typeof m === "string")
    : [];
  if (amount === null) return null;
  if (amount === 0 && unpricedCalls > 0) return null;
  return {
    amount,
    currency: typeof cost.currency === "string" ? cost.currency : "USD",
    unpricedModels: models,
    unpricedCalls,
  };
}

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
