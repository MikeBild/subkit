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

export const CONSUMPTION_AXES = [
  "workflow",
  "flow",
  "user",
  "model",
  "conversation",
  "execution",
] as const;
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

export interface UsageTokens {
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

export interface ModelPrice {
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  currency: string;
}

export interface LlmBucketView {
  ts: string;
  calls: number;
  tokens: UsageTokens;
  cost: number | null;
}

export interface LlmGroupView {
  key: Record<string, string>;
  calls: number;
  tokens: UsageTokens;
  latencyP50: number | null;
  results: Record<string, number>;
  cost: number | null;
  unpricedCalls: number;
  cacheSavings: number;
  modelName: string | null;
  modelPrice: ModelPrice | null;
  conversation: { title: string | null; ownerId: string | null; updatedAt: string } | null;
  buckets: LlmBucketView[];
}

function tokensOf(value: unknown): UsageTokens {
  const t = isRecord(value) ? value : {};
  return {
    prompt: numberOrNull(t.prompt) ?? 0,
    completion: numberOrNull(t.completion) ?? 0,
    cacheRead: numberOrNull(t.cache_read) ?? 0,
    cacheCreation: numberOrNull(t.cache_creation) ?? 0,
    total: numberOrNull(t.total) ?? 0,
  };
}

function resultsOf(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(value)) {
    const count = numberOrNull(n);
    if (count !== null) out[key] = count;
  }
  return out;
}

function pricedAmount(value: unknown): { amount: number | null; unpriced: number; saved: number } {
  if (!isRecord(value)) return { amount: null, unpriced: 0, saved: 0 };
  const amount = numberOrNull(value.amount);
  const unpriced = numberOrNull(value.unpriced_calls) ?? 0;
  return {
    amount: amount === null || (amount === 0 && unpriced > 0) ? null : amount,
    unpriced,
    saved: numberOrNull(value.cache_savings) ?? 0,
  };
}

function modelPriceOf(value: unknown): ModelPrice | null {
  if (!isRecord(value)) return null;
  const input = numberOrNull(value.input_per_mtok);
  const output = numberOrNull(value.output_per_mtok);
  if (input === null || output === null) return null;
  return {
    inputPerMtok: input,
    outputPerMtok: output,
    cacheReadPerMtok: numberOrNull(value.cache_read_per_mtok) ?? 0,
    currency: typeof value.currency === "string" ? value.currency : "USD",
  };
}

function conversationOf(value: unknown): LlmGroupView["conversation"] {
  if (!isRecord(value)) return null;
  return {
    title: typeof value.title === "string" ? value.title : null,
    ownerId: typeof value.owner_id === "string" ? value.owner_id : null,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : "",
  };
}

function bucketsOf(value: unknown): LlmBucketView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((bucket): LlmBucketView[] => {
    if (!isRecord(bucket) || typeof bucket.ts !== "string") return [];
    return [
      {
        ts: bucket.ts,
        calls: numberOrNull(bucket.calls) ?? 0,
        tokens: tokensOf(bucket.tokens),
        cost: pricedAmount(bucket.cost).amount,
      },
    ];
  });
}

export function llmGroups(envelope: unknown): LlmGroupView[] {
  const groups = isRecord(envelope) && Array.isArray(envelope.groups) ? envelope.groups : [];
  return groups.flatMap((group): LlmGroupView[] => {
    if (!isRecord(group) || !isRecord(group.key)) return [];
    const key: Record<string, string> = {};
    for (const [name, value] of Object.entries(group.key)) {
      if (typeof value === "string") key[name] = value;
    }
    const totals = isRecord(group.totals) ? group.totals : {};
    const latency = isRecord(totals.latency_ms) ? totals.latency_ms : {};
    const cost = pricedAmount(group.cost);
    return [
      {
        key,
        calls: numberOrNull(totals.calls) ?? 0,
        tokens: tokensOf(totals.tokens),
        latencyP50: numberOrNull(latency.p50),
        results: resultsOf(totals.result),
        cost: cost.amount,
        unpricedCalls: cost.unpriced,
        cacheSavings: cost.saved,
        modelName: typeof group.model_name === "string" ? group.model_name : null,
        modelPrice: modelPriceOf(group.model_price),
        conversation: conversationOf(group.conversation),
        buckets: bucketsOf(group.buckets),
      },
    ];
  });
}

export const FAILED_RESULTS = ["error", "context_too_large", "quota_exhausted"] as const;

export function isFailedResult(result: string): boolean {
  return (FAILED_RESULTS as readonly string[]).includes(result);
}

export function failedOf(results: Record<string, number>): number {
  return Object.entries(results)
    .filter(([result]) => isFailedResult(result))
    .reduce((sum, [, n]) => sum + n, 0);
}

export interface LlmWindow {
  calls: number;
  failedCalls: number;
  tokens: UsageTokens;
  cost: WindowCost | null;
  cacheSavings: number;
  cacheShare: number | null;
}

export function llmWindow(envelope: unknown): LlmWindow | null {
  if (!isRecord(envelope) || !isRecord(envelope.totals)) return null;
  const calls = isRecord(envelope.totals.calls) ? envelope.totals.calls : {};
  const total = numberOrNull(calls.total);
  if (total === null) return null;
  const tokens = tokensOf(envelope.totals.tokens);
  const cost = isRecord(envelope.cost) ? envelope.cost : {};
  return {
    calls: total,
    failedCalls: failedOf(resultsOf(calls.by_result)),
    tokens,
    cost: windowCost(envelope),
    cacheSavings: numberOrNull(cost.cache_savings) ?? 0,
    cacheShare: tokens.prompt > 0 ? tokens.cacheRead / tokens.prompt : null,
  };
}

export const TREND_SAME_BELOW_PERCENT = 5;

export type Trend =
  | { kind: "none" }
  | { kind: "new" }
  | { kind: "same" }
  | { kind: "more" | "less"; percent: number };

export function trendOf(current: number | null, previous: number | null | undefined): Trend {
  if (current === null || previous === null || previous === undefined) return { kind: "none" };
  if (previous === 0) return current > 0 ? { kind: "new" } : { kind: "same" };
  const change = (current / previous - 1) * 100;
  if (Math.abs(change) < TREND_SAME_BELOW_PERCENT) return { kind: "same" };
  return { kind: change > 0 ? "more" : "less", percent: Math.round(Math.abs(change)) };
}

export const FORECAST_TIGHT_SHARE = 0.9;
export const FORECAST_MIN_DAY = 3;
const DAY_MS = 86_400_000;

export type BudgetForecast =
  | { kind: "uncapped" }
  | { kind: "exhausted" }
  | { kind: "insufficient" }
  | { kind: "lasts" }
  | { kind: "tight"; percent: number }
  | { kind: "runsOut"; day: number };

export function budgetForecast(input: {
  usedTokens: number | null;
  budgetTokens: number | null;
  lastSevenDaysTokens: number | null;
  now: Date;
}): BudgetForecast | null {
  const { usedTokens, budgetTokens, lastSevenDaysTokens, now } = input;
  if (budgetTokens === null || budgetTokens <= 0) return { kind: "uncapped" };
  if (usedTokens === null) return null;
  if (usedTokens >= budgetTokens) return { kind: "exhausted" };
  if (now.getDate() < FORECAST_MIN_DAY) return { kind: "insufficient" };
  if (lastSevenDaysTokens === null) return null;
  const perDay = lastSevenDaysTokens / 7;
  if (perDay <= 0) return { kind: "lasts" };
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const remainingDays = (monthEnd.getTime() - now.getTime()) / DAY_MS;
  const projected = usedTokens + perDay * remainingDays;
  if (projected > budgetTokens) {
    const at = new Date(now.getTime() + ((budgetTokens - usedTokens) / perDay) * DAY_MS);
    return { kind: "runsOut", day: at.getDate() };
  }
  if (projected >= budgetTokens * FORECAST_TIGHT_SHARE)
    return { kind: "tight", percent: Math.floor((projected / budgetTokens) * 100) };
  return { kind: "lasts" };
}

export type BucketUnit = "hour" | "day";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function localBucketKey(date: Date, unit: BucketUnit): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return unit === "hour" ? `${day}T${pad(date.getHours())}` : day;
}

export function engineBucketKey(ts: string, unit: BucketUnit): string {
  return unit === "hour" ? ts.slice(0, 13) : ts.slice(0, 10);
}

const MAX_BUCKETS = 800;

export function bucketTimeline(span: { from: string; to: string }, unit: BucketUnit): Date[] {
  const from = new Date(span.from);
  const to = new Date(span.to);
  const cursor =
    unit === "hour"
      ? new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours())
      : new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const out: Date[] = [];
  while (cursor < to && out.length < MAX_BUCKETS) {
    out.push(new Date(cursor));
    if (unit === "hour") cursor.setHours(cursor.getHours() + 1);
    else cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

export interface ChartBucket {
  at: Date;
  values: Record<UsageOrigin, number>;
  total: number;
}

export interface OriginChart {
  measure: "cost" | "tokens";
  buckets: ChartBucket[];
}

function emptyOrigins(): Record<UsageOrigin, number> {
  return {
    chat: 0,
    authoring: 0,
    summaries: 0,
    reviews: 0,
    knowledge: 0,
    workflowRuns: 0,
    other: 0,
  };
}

export function originChart(
  envelope: unknown,
  span: { from: string; to: string },
  unit: BucketUnit,
): OriginChart {
  const groups = llmGroups(envelope).filter((group) => group.key.flow !== undefined);
  const measure = groups.some((group) => group.cost !== null) ? "cost" : "tokens";
  const byKey = new Map<string, Record<UsageOrigin, number>>();
  for (const group of groups) {
    const origin = flowOrigin(group.key.flow ?? "");
    for (const bucket of group.buckets) {
      const key = engineBucketKey(bucket.ts, unit);
      const values = byKey.get(key) ?? emptyOrigins();
      values[origin] += measure === "cost" ? (bucket.cost ?? 0) : bucket.tokens.total;
      byKey.set(key, values);
    }
  }
  return {
    measure,
    buckets: bucketTimeline(span, unit).map((at) => {
      const values = byKey.get(localBucketKey(at, unit)) ?? emptyOrigins();
      const total = USAGE_ORIGINS.reduce((sum, origin) => sum + values[origin], 0);
      return { at, values, total };
    }),
  };
}

export const BREAKDOWN_DIMS = ["workflow", "person", "model", "conversation"] as const;
export type BreakdownDim = (typeof BREAKDOWN_DIMS)[number];

export const BREAKDOWN_AXIS: Record<BreakdownDim, ConsumptionAxis> = {
  workflow: "workflow",
  person: "user",
  model: "model",
  conversation: "conversation",
};

export function isBreakdownDim(value: string): value is BreakdownDim {
  return (BREAKDOWN_DIMS as readonly string[]).includes(value);
}

export interface BreakdownRow {
  key: string;
  group: LlmGroupView;
  cost: number | null;
  calls: number;
  tokens: number;
  failedCalls: number;
  share: number | null;
  trend: Trend;
}

export interface BreakdownRemainder {
  cost: number | null;
  calls: number;
  share: number | null;
}

export interface Breakdown {
  measure: "cost" | "tokens";
  rows: BreakdownRow[];
  remainder: BreakdownRemainder | null;
}

const REMAINDER_MIN = 0.005;

export function breakdown(
  envelope: unknown,
  axis: ConsumptionAxis,
  window: LlmWindow,
  previous?: unknown,
): Breakdown {
  const measure = window.cost ? "cost" : "tokens";
  const windowMeasure = measure === "cost" ? (window.cost?.amount ?? 0) : window.tokens.total;
  const value = (cost: number | null, tokens: number) =>
    measure === "cost" ? (cost ?? 0) : tokens;
  const before =
    previous === undefined
      ? null
      : new Map(
          llmGroups(previous).map((group) => [
            group.key[axis] ?? "",
            value(group.cost, group.tokens.total),
          ]),
        );
  const rows = llmGroups(envelope)
    .filter((group) => (group.key[axis] ?? "") !== "")
    .map((group): BreakdownRow => {
      const key = group.key[axis] ?? "";
      const own = value(group.cost, group.tokens.total);
      const comparable = before !== null && !(measure === "cost" && group.cost === null);
      return {
        key,
        group,
        cost: group.cost,
        calls: group.calls,
        tokens: group.tokens.total,
        failedCalls: failedOf(group.results),
        share: windowMeasure > 0 ? own / windowMeasure : null,
        trend: comparable ? trendOf(own, before.get(key) ?? 0) : { kind: "none" },
      };
    })
    .sort(
      (a, b) =>
        value(b.cost, b.tokens) - value(a.cost, a.tokens) ||
        b.calls - a.calls ||
        (a.key < b.key ? -1 : 1),
    );
  const covered = rows.reduce((sum, row) => sum + value(row.cost, row.tokens), 0);
  const coveredCalls = rows.reduce((sum, row) => sum + row.calls, 0);
  const restMeasure = Math.max(0, windowMeasure - covered);
  const restCalls = Math.max(0, window.calls - coveredCalls);
  const remainder =
    restCalls > 0 || restMeasure > REMAINDER_MIN
      ? {
          cost: measure === "cost" ? restMeasure : null,
          calls: restCalls,
          share: windowMeasure > 0 ? restMeasure / windowMeasure : null,
        }
      : null;
  return { measure, rows, remainder };
}

export const RUN_COST_FACTOR = 1.5;
export const PERSON_SHARE = 0.5;
export const MAX_RUN_HINTS = 3;

export type UsageHint =
  | { kind: "runCost"; workflowId: string; factor: number }
  | { kind: "unpricedModel"; model: string }
  | { kind: "unpricedModels"; count: number }
  | { kind: "budget"; day: number }
  | { kind: "personShare"; userId: string; percent: number };

export interface WorkflowRunCost {
  workflowId: string;
  cost: number | null;
  runs: number;
  previousCost: number | null;
  previousRuns: number;
}

export function runCostFactor(w: WorkflowRunCost): number | null {
  if (w.cost === null || w.previousCost === null) return null;
  if (w.runs <= 0 || w.previousRuns <= 0 || w.previousCost <= 0) return null;
  return Math.round((w.cost / w.runs / (w.previousCost / w.previousRuns)) * 10) / 10;
}

export function usageHints(input: {
  workflows: readonly WorkflowRunCost[];
  unpricedModels: readonly string[];
  forecast: BudgetForecast | null;
  persons: readonly BreakdownRow[] | null;
}): UsageHint[] {
  const hints: UsageHint[] = input.workflows
    .flatMap((w): UsageHint[] => {
      const factor = runCostFactor(w);
      return factor !== null && factor >= RUN_COST_FACTOR
        ? [{ kind: "runCost", workflowId: w.workflowId, factor }]
        : [];
    })
    .sort((a, b) =>
      a.kind === "runCost" && b.kind === "runCost"
        ? b.factor - a.factor || (a.workflowId < b.workflowId ? -1 : 1)
        : 0,
    )
    .slice(0, MAX_RUN_HINTS);
  const [onlyModel] = input.unpricedModels;
  if (input.unpricedModels.length === 1 && onlyModel)
    hints.push({ kind: "unpricedModel", model: onlyModel });
  else if (input.unpricedModels.length > 1)
    hints.push({ kind: "unpricedModels", count: input.unpricedModels.length });
  if (input.forecast?.kind === "runsOut") hints.push({ kind: "budget", day: input.forecast.day });
  const persons = input.persons ?? [];
  const top = persons[0];
  if (persons.length >= 2 && top && top.share !== null && top.share >= PERSON_SHARE)
    hints.push({ kind: "personShare", userId: top.key, percent: Math.round(top.share * 100) });
  return hints;
}

export function mainDriver(
  current: ReadonlyArray<{ key: string; cost: number | null }>,
  previous: ReadonlyMap<string, number>,
): { key: string; delta: number } | null {
  let best: { key: string; delta: number } | null = null;
  for (const row of current) {
    if (row.cost === null) continue;
    const delta = row.cost - (previous.get(row.key) ?? 0);
    if (delta <= 0) continue;
    if (!best || delta > best.delta || (delta === best.delta && row.key < best.key))
      best = { key: row.key, delta };
  }
  return best;
}

export interface FailureRow {
  workflowId: string | null;
  conversationId: string | null;
  title: string | null;
  calls: number;
  cost: number | null;
  reasons: Array<{ result: string; calls: number }>;
}

export function failureRows(envelope: unknown): FailureRow[] {
  return llmGroups(envelope)
    .map((group): FailureRow => {
      const reasons = Object.entries(group.results)
        .filter(([result, n]) => isFailedResult(result) && n > 0)
        .map(([result, calls]) => ({ result, calls }))
        .sort((a, b) => b.calls - a.calls || (a.result < b.result ? -1 : 1));
      return {
        workflowId: group.key.workflow || null,
        conversationId: group.key.conversation || null,
        title: group.conversation?.title ?? null,
        calls: reasons.reduce((sum, reason) => sum + reason.calls, 0),
        cost: group.cost,
        reasons,
      };
    })
    .filter((row) => row.calls > 0)
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.calls - a.calls);
}

export interface CsvLabels {
  period: string;
  origin: string;
  model: string;
  calls: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWritten: string;
  cost: string;
  currency: string;
  originName(origin: UsageOrigin): string;
}

const CSV_SPECIAL = /[",;\r\n]/;

function csvCell(value: string): string {
  return CSV_SPECIAL.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function usageCsv(envelope: unknown, unit: BucketUnit, labels: CsvLabels): string {
  const currency =
    isRecord(envelope) && isRecord(envelope.cost) && typeof envelope.cost.currency === "string"
      ? envelope.cost.currency
      : "";
  const lines = llmGroups(envelope).flatMap((group) =>
    group.buckets.map((bucket) => [
      engineBucketKey(bucket.ts, unit),
      labels.originName(flowOrigin(group.key.flow ?? "")),
      group.key.model ?? "",
      String(bucket.calls),
      String(bucket.tokens.prompt),
      String(bucket.tokens.completion),
      String(bucket.tokens.cacheRead),
      String(bucket.tokens.cacheCreation),
      bucket.cost === null ? "" : String(bucket.cost),
      bucket.cost === null ? "" : currency,
    ]),
  );
  const order = (line: string[]) => `${line[0]}|${line[1]}|${line[2]}`;
  lines.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  const header = [
    labels.period,
    labels.origin,
    labels.model,
    labels.calls,
    labels.input,
    labels.output,
    labels.cacheRead,
    labels.cacheWritten,
    labels.cost,
    labels.currency,
  ];
  return [header, ...lines].map((line) => line.map(csvCell).join(",")).join("\r\n");
}

export type UsageSheet =
  | { kind: "origin"; id: UsageOrigin }
  | { kind: "workflow" | "person" | "model" | "conversation"; id: string }
  | { kind: "failed" };

const SHEET_PARAMS = ["origin", "workflow", "person", "model", "conversation", "failed"] as const;

export function usageSheetFromSearch(search: string): UsageSheet | null {
  const params = new URLSearchParams(search);
  for (const name of SHEET_PARAMS) {
    const value = params.get(name);
    if (value === null || value === "") continue;
    if (name === "failed") return { kind: "failed" };
    if (name === "origin")
      return (USAGE_ORIGINS as readonly string[]).includes(value)
        ? { kind: "origin", id: value as UsageOrigin }
        : null;
    return { kind: name, id: value };
  }
  return null;
}

export function usageSheetSearch(search: string, sheet: UsageSheet | null): string {
  const params = new URLSearchParams(search);
  for (const name of SHEET_PARAMS) params.delete(name);
  if (sheet) params.set(sheet.kind, sheet.kind === "failed" ? "1" : sheet.id);
  const query = params.toString();
  return query ? `?${query}` : "";
}
