import { auditHref, connectorsHref, runsHref, settingsHref, usageHref } from "@/app/links";
import {
  DEFAULT_STATS_WINDOW,
  isStatsWindow,
  STATS_WINDOWS,
  type StatsWindow,
} from "@/lib/stats-window";
import {
  type BudgetSummary,
  budgetPercent,
  budgetPressure,
  type ConsumptionAxis,
  type WindowCost,
  windowCost,
} from "./usage-model";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export { DEFAULT_STATS_WINDOW, isStatsWindow, STATS_WINDOWS, type StatsWindow };

export function windowBucket(window: StatsWindow): "hour" | "day" {
  return window === "24h" ? "hour" : "day";
}

export interface TimeSpan {
  from: string;
  to: string;
}

export interface WindowBounds extends TimeSpan {
  window: StatsWindow;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7));
}

function shiftDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function span(window: StatsWindow, now: Date): { from: Date; to: Date } {
  if (window === "24h") return { from: new Date(now.getTime() - 24 * 3_600_000), to: now };
  if (window === "thisWeek") return { from: startOfWeek(now), to: now };
  if (window === "lastWeek") {
    const to = startOfWeek(now);
    return { from: shiftDays(to, -7), to };
  }
  if (window === "thisMonth")
    return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
  return {
    from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
    to: new Date(now.getFullYear(), now.getMonth(), 1),
  };
}

export function windowBounds(window: StatsWindow, now = new Date()): WindowBounds {
  const { from, to } = span(window, now);
  return { window, from: from.toISOString(), to: to.toISOString() };
}

function shiftMonthsClamped(date: Date, months: number): Date {
  const first = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(
    first.getFullYear(),
    first.getMonth(),
    Math.min(date.getDate(), lastDay),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

export function previousBounds(bounds: WindowBounds): TimeSpan {
  const from = new Date(bounds.from);
  const to = new Date(bounds.to);
  const iso = (a: Date, b: Date): TimeSpan => ({ from: a.toISOString(), to: b.toISOString() });
  if (bounds.window === "24h") return iso(new Date(from.getTime() - 24 * 3_600_000), from);
  if (bounds.window === "thisWeek") {
    const back = (date: Date) =>
      new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate() - 7,
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
        date.getMilliseconds(),
      );
    return iso(back(from), back(to));
  }
  if (bounds.window === "lastWeek") return iso(shiftDays(from, -7), from);
  if (bounds.window === "thisMonth")
    return iso(new Date(from.getFullYear(), from.getMonth() - 1, 1), shiftMonthsClamped(to, -1));
  return iso(new Date(from.getFullYear(), from.getMonth() - 1, 1), from);
}

export function rollingDays(days: number, now = new Date()): TimeSpan {
  const from = new Date(now.getTime() - days * 24 * 3_600_000);
  return { from: from.toISOString(), to: now.toISOString() };
}

export function usageWindowFromUrl(search: string): StatsWindow {
  const raw = new URLSearchParams(search).get("window") ?? "";
  return isStatsWindow(raw) ? raw : DEFAULT_STATS_WINDOW;
}

export function usageWindowSearch(search: string, window: StatsWindow): string {
  const params = new URLSearchParams(search);
  if (window === DEFAULT_STATS_WINDOW) params.delete("window");
  else params.set("window", window);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function windowQuery(bounds: TimeSpan & { window: StatsWindow }): string {
  return [
    `bucket=${windowBucket(bounds.window)}`,
    `from=${encodeURIComponent(bounds.from)}`,
    `to=${encodeURIComponent(bounds.to)}`,
    `tz=${encodeURIComponent(timeZone())}`,
  ].join("&");
}

export function executionStatsEndpoint(bounds: TimeSpan & { window: StatsWindow }): string {
  return `/v1/stats/executions?${windowQuery(bounds)}`;
}

export interface LlmStatsFilter {
  userId?: string;
  flows?: readonly string[];
  results?: readonly string[];
  workflowId?: string;
}

export function llmStatsEndpoint(
  bounds: TimeSpan & { window: StatsWindow },
  axis?: ConsumptionAxis | readonly ConsumptionAxis[],
  filter: LlmStatsFilter = {},
): string {
  const axes = axis === undefined ? [] : typeof axis === "string" ? [axis] : axis;
  const parts = [windowQuery(bounds)];
  if (axes.length > 0) parts.push(`group_by=${axes.join(",")}`);
  if (filter.userId) parts.push(`user_id=${encodeURIComponent(filter.userId)}`);
  if (filter.flows && filter.flows.length > 0)
    parts.push(`flow=${filter.flows.map(encodeURIComponent).join(",")}`);
  if (filter.results && filter.results.length > 0) parts.push(`result=${filter.results.join(",")}`);
  if (filter.workflowId) parts.push(`workflow_id=${encodeURIComponent(filter.workflowId)}`);
  return `/v1/stats/llm?${parts.join("&")}`;
}

export const REPAIR_REQUIRED_ENDPOINT = "/v1/workflows?operating_status=repair_required&limit=1";

export function repairRequiredCount(envelope: unknown): number | null {
  return isRecord(envelope) ? countOf(envelope.total) : null;
}

export const STATUS_ENDPOINT = "/v1/status";

interface WindowSpend {
  calls: number | null;
  cost: WindowCost | null;
}

export function windowSpend(envelope: unknown): WindowSpend {
  const totals = isRecord(envelope) && isRecord(envelope.totals) ? envelope.totals : {};
  const calls = isRecord(totals.calls) ? numberOrNull(totals.calls.total) : null;
  return { calls, cost: windowCost(envelope) };
}

export function operatingFiguresEndpoint(bounds: WindowBounds): string {
  return `/v1/stats/operating-figures?from=${encodeURIComponent(bounds.from)}&to=${encodeURIComponent(bounds.to)}`;
}

export interface OperatingCounts {
  runs: {
    total: number;
    failed: number;
    successRatePercent: number | null;
  };
  connectors: {
    enabled: number;
    notOk: number;
    needsReauth: number;
    healthyPercent: number | null;
  };
  repairs: { decided: number; appliedPercent: number | null };
}

function countOf(value: unknown): number | null {
  const n = numberOrNull(value);
  return n !== null && n >= 0 ? n : null;
}

export function operatingCounts(envelope: unknown): OperatingCounts | null {
  if (!isRecord(envelope)) return null;
  const { runs, connectors, repairs } = envelope;
  if (!isRecord(runs) || !isRecord(connectors) || !isRecord(repairs)) return null;
  const total = countOf(runs.total);
  const failed = countOf(runs.failed);
  const enabled = countOf(connectors.enabled);
  const notOk = countOf(connectors.not_ok);
  const needsReauth = countOf(connectors.needs_reauth);
  const decided = countOf(repairs.decided);
  if (
    total === null ||
    failed === null ||
    enabled === null ||
    notOk === null ||
    needsReauth === null ||
    decided === null
  )
    return null;
  return {
    runs: { total, failed, successRatePercent: numberOrNull(runs.success_rate_percent) },
    connectors: {
      enabled,
      notOk,
      needsReauth,
      healthyPercent: numberOrNull(connectors.healthy_percent),
    },
    repairs: { decided, appliedPercent: numberOrNull(repairs.applied_percent) },
  };
}

export interface PromptCacheFlow {
  flow: string;
  calls: number;
  promptTokens: number;
  cacheReadTokens: number;
  percent: number | null;
}

export function promptCacheFlows(envelope: unknown): PromptCacheFlow[] | null {
  if (!isRecord(envelope) || !isRecord(envelope.prompt_cache)) return null;
  const { flows } = envelope.prompt_cache;
  if (!Array.isArray(flows)) return null;
  return flows.flatMap((row): PromptCacheFlow[] => {
    if (!isRecord(row) || typeof row.flow !== "string" || row.flow === "") return [];
    const promptTokens = countOf(row.prompt_tokens) ?? 0;
    const percent = numberOrNull(row.cache_read_percent);
    return [
      {
        flow: row.flow,
        calls: countOf(row.calls) ?? 0,
        promptTokens,
        cacheReadTokens: countOf(row.cache_read_tokens) ?? 0,
        percent: promptTokens > 0 && percent !== null ? Math.min(Math.max(percent, 0), 100) : null,
      },
    ];
  });
}

export function promptCacheShare(flows: readonly PromptCacheFlow[]): number | null {
  let prompt = 0;
  let cacheRead = 0;
  for (const flow of flows) {
    if (flow.percent === null) continue;
    prompt += flow.promptTokens;
    cacheRead += flow.cacheReadTokens;
  }
  return prompt > 0 ? Math.min(Math.round((cacheRead / prompt) * 100), 100) : null;
}

export const DECIDED_REPAIR_ACTIONS = [
  "patch_candidate.approved",
  "patch_candidate.auto_applied",
  "patch_candidate.rejected",
] as const;

export const OPERATING_FIGURE_IDS = [
  "runs",
  "successRate",
  "connectorHealth",
  "repairRate",
  "cost",
  "budget",
] as const;
export type OperatingFigureId = (typeof OPERATING_FIGURE_IDS)[number];

export type FigureBasis = "window" | "now";

export const BUDGET_SETTING = "tokens.monthly_budget";

export type Read<T> = { state: "answered"; value: T } | { state: "failed" };

export type BudgetHint =
  | {
      kind: "share";
      percent: number;
      budgetTokens: number;
      remainingTokens: number | null;
      pressure: "ample" | "tightening" | "critical";
    }
  | { kind: "uncapped"; href: string | null }
  | { kind: "unreadable" };

export type OperatingFigure =
  | {
      id: OperatingFigureId;
      state: "value";
      value: number;
      href: string | null;
      basis: FigureBasis;
      detail?:
        | { kind: "failures"; count: number }
        | { kind: "connectors"; count: number; needsReauth: number };
      money?: { currency: string; unpricedCalls: number };
      hint?: BudgetHint;
    }
  | {
      id: OperatingFigureId;
      state: "none" | "unreadable" | "not_permitted";
      basis: FigureBasis;
      hint?: BudgetHint;
    }
  | {
      id: "cost" | "budget";
      state: "unpriced";
      href: string | null;
      basis: FigureBasis;
      hint?: BudgetHint;
    };

export function operatingFigures(input: {
  bounds: WindowBounds;
  counts: Read<OperatingCounts | null>;
  connectorsPermitted: boolean;
  spend: Read<WindowSpend>;
  budget: Read<BudgetSummary>;
  canOpen: {
    runs: boolean;
    connectors: boolean;
    audit: boolean;
    usage: boolean;
    budgetSetting: boolean;
  };
}): OperatingFigure[] {
  const { bounds, counts, connectorsPermitted, spend, budget, canOpen } = input;
  const window = { startedFrom: bounds.from, startedTo: bounds.to };
  const read = counts.state === "answered" ? counts.value : null;

  let runs: OperatingFigure;
  let successRate: OperatingFigure;
  if (read === null) {
    runs = { id: "runs", state: "unreadable", basis: "window" };
    successRate = { id: "successRate", state: "unreadable", basis: "window" };
  } else if (read.runs.total > 0) {
    const { total, failed, successRatePercent } = read.runs;
    runs = {
      id: "runs",
      state: "value",
      value: total,
      detail: { kind: "failures", count: failed },
      href: canOpen.runs ? runsHref(window) : null,
      basis: "window",
    };
    successRate =
      successRatePercent === null
        ? { id: "successRate", state: "none", basis: "window" }
        : {
            id: "successRate",
            state: "value",
            value: successRatePercent,
            href: canOpen.runs && failed > 0 ? runsHref({ ...window, status: "failed" }) : null,
            basis: "window",
          };
  } else {
    runs = { id: "runs", state: "none", basis: "window" };
    successRate = { id: "successRate", state: "none", basis: "window" };
  }

  let connectorHealth: OperatingFigure;
  if (!connectorsPermitted) {
    connectorHealth = { id: "connectorHealth", state: "not_permitted", basis: "now" };
  } else if (read === null) {
    connectorHealth = { id: "connectorHealth", state: "unreadable", basis: "now" };
  } else if (read.connectors.enabled > 0 && read.connectors.healthyPercent !== null) {
    connectorHealth = {
      id: "connectorHealth",
      state: "value",
      value: read.connectors.healthyPercent,
      detail: {
        kind: "connectors",
        count: read.connectors.notOk,
        needsReauth: read.connectors.needsReauth,
      },
      href:
        canOpen.connectors && read.connectors.notOk > 0
          ? connectorsHref({ health: "not_ok" })
          : null,
      basis: "now",
    };
  } else {
    connectorHealth = { id: "connectorHealth", state: "none", basis: "now" };
  }

  let repairRate: OperatingFigure;
  if (read === null) {
    repairRate = { id: "repairRate", state: "unreadable", basis: "window" };
  } else if (read.repairs.decided > 0 && read.repairs.appliedPercent !== null) {
    repairRate = {
      id: "repairRate",
      state: "value",
      value: read.repairs.appliedPercent,
      href: canOpen.audit
        ? auditHref({
            scope: "all",
            actions: DECIDED_REPAIR_ACTIONS,
            tsFrom: bounds.from,
            tsTo: bounds.to,
          })
        : null,
      basis: "window",
    };
  } else {
    repairRate = { id: "repairRate", state: "none", basis: "window" };
  }

  return [
    runs,
    successRate,
    connectorHealth,
    repairRate,
    costFigure(spend, bounds, canOpen.usage),
    budgetFigure(budget, spend, bounds, canOpen),
  ];
}

function costFigure(
  spend: Read<WindowSpend>,
  bounds: WindowBounds,
  canOpen: boolean,
): OperatingFigure {
  if (spend.state === "failed") return { id: "cost", state: "unreadable", basis: "window" };
  const href = canOpen ? usageHref({ window: bounds.window }) : null;
  const { calls, cost } = spend.value;
  if (calls === 0) return { id: "cost", state: "none", basis: "window" };
  if (cost === null)
    return calls !== null
      ? { id: "cost", state: "unpriced", href, basis: "window" }
      : { id: "cost", state: "none", basis: "window" };
  return {
    id: "cost",
    state: "value",
    value: cost.amount,
    href,
    basis: "window",
    money: { currency: cost.currency, unpricedCalls: cost.unpricedCalls },
  };
}

function budgetHint(budget: Read<BudgetSummary>, canSet: boolean): BudgetHint {
  if (budget.state === "failed") return { kind: "unreadable" };
  const summary = budget.value;
  if (summary.budgetTokens === null)
    return { kind: "uncapped", href: canSet ? settingsHref(BUDGET_SETTING) : null };
  const percent = budgetPercent(summary);
  const pressure = budgetPressure(summary);
  if (percent === null || pressure === null) return { kind: "unreadable" };
  return {
    kind: "share",
    percent,
    budgetTokens: summary.budgetTokens,
    remainingTokens: summary.remainingTokens,
    pressure,
  };
}

function budgetFigure(
  budget: Read<BudgetSummary>,
  spend: Read<WindowSpend>,
  bounds: WindowBounds,
  canOpen: { usage: boolean; budgetSetting: boolean },
): OperatingFigure {
  if (spend.state === "failed") return { id: "budget", state: "unreadable", basis: "window" };
  const hint = budgetHint(budget, canOpen.budgetSetting);
  const href = canOpen.usage ? usageHref({ window: bounds.window }) : null;
  const { calls, cost } = spend.value;
  if (calls === 0 || (calls === null && cost === null))
    return { id: "budget", state: "none", basis: "window", hint };
  if (cost === null) return { id: "budget", state: "unpriced", href, basis: "window", hint };
  return {
    id: "budget",
    state: "value",
    value: cost.amount,
    href,
    basis: "window",
    money: { currency: cost.currency, unpricedCalls: cost.unpricedCalls },
    hint,
  };
}
