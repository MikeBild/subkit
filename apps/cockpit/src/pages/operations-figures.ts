import { auditHref, connectorsHref, runsHref, settingsHref, usageHref } from "@/app/links";
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

export const STATS_WINDOWS = ["24h", "7d", "30d"] as const;
export type StatsWindow = (typeof STATS_WINDOWS)[number];

const WINDOW_SHAPE: Record<StatsWindow, { bucket: "hour" | "day"; hours: number }> = {
  "24h": { bucket: "hour", hours: 24 },
  "7d": { bucket: "day", hours: 7 * 24 },
  "30d": { bucket: "day", hours: 30 * 24 },
};

export function windowBucket(window: StatsWindow): "hour" | "day" {
  return WINDOW_SHAPE[window].bucket;
}

export interface WindowBounds {
  window: StatsWindow;
  from: string;
  to: string;
}

export function windowBounds(window: StatsWindow, now = new Date()): WindowBounds {
  const from = new Date(now.getTime() - WINDOW_SHAPE[window].hours * 3_600_000);
  return { window, from: from.toISOString(), to: now.toISOString() };
}

export function usageWindowFromUrl(search: string): StatsWindow {
  const raw = new URLSearchParams(search).get("window");
  return (STATS_WINDOWS as readonly string[]).includes(raw ?? "") ? (raw as StatsWindow) : "7d";
}

export function usageWindowSearch(search: string, window: StatsWindow): string {
  const params = new URLSearchParams(search);
  if (window === "7d") params.delete("window");
  else params.set("window", window);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function windowQuery(bounds: WindowBounds): string {
  return [
    `bucket=${WINDOW_SHAPE[bounds.window].bucket}`,
    `from=${encodeURIComponent(bounds.from)}`,
    `to=${encodeURIComponent(bounds.to)}`,
  ].join("&");
}

export function executionStatsEndpoint(bounds: WindowBounds): string {
  return `/v1/stats/executions?${windowQuery(bounds)}`;
}

export function llmStatsEndpoint(bounds: WindowBounds, axis?: ConsumptionAxis): string {
  return `/v1/stats/llm?${windowQuery(bounds)}${axis ? `&group_by=${axis}` : ""}`;
}

export function monthSpendEndpoint(now = new Date()): string {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return `/v1/stats/llm?bucket=day&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(now.toISOString())}`;
}

export const STATUS_ENDPOINT = "/v1/status";

export interface WindowSpend {
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
  connectors: { enabled: number; notOk: number; healthyPercent: number | null };
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
  const decided = countOf(repairs.decided);
  if (total === null || failed === null || enabled === null || notOk === null || decided === null)
    return null;
  return {
    runs: { total, failed, successRatePercent: numberOrNull(runs.success_rate_percent) },
    connectors: { enabled, notOk, healthyPercent: numberOrNull(connectors.healthy_percent) },
    repairs: { decided, appliedPercent: numberOrNull(repairs.applied_percent) },
  };
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

export type FigureBasis = "window" | "now" | "month";

export const BUDGET_SETTING = "tokens.monthly_budget";

export type Read<T> = { state: "answered"; value: T } | { state: "failed" };

export type OperatingFigure =
  | {
      id: OperatingFigureId;
      state: "value";
      value: number;
      href: string | null;
      basis: FigureBasis;
      detail?: { kind: "failures" | "connectors"; count: number };
      money?: { currency: string; unpricedCalls: number };
      budget?: {
        percent: number;
        budgetTokens: number;
        remainingTokens: number | null;
        pressure: "ample" | "tightening" | "critical";
      };
      uncapped?: true;
    }
  | {
      id: OperatingFigureId;
      state: "none" | "unreadable" | "not_permitted";
      basis: FigureBasis;
    }
  | {
      id: "cost";
      state: "unpriced";
      href: string | null;
      basis: FigureBasis;
    }
  | {
      id: "budget";
      state: "uncapped";
      href: string | null;
      basis: FigureBasis;
    };

export function operatingFigures(input: {
  bounds: WindowBounds;
  counts: Read<OperatingCounts | null>;
  connectorsPermitted: boolean;
  spend: Read<WindowSpend>;
  budget: Read<BudgetSummary>;
  monthSpend: Read<WindowSpend>;
  canOpen: {
    runs: boolean;
    connectors: boolean;
    audit: boolean;
    usage: boolean;
    budgetSetting: boolean;
  };
}): OperatingFigure[] {
  const { bounds, counts, connectorsPermitted, spend, budget, monthSpend, canOpen } = input;
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
      detail: { kind: "connectors", count: read.connectors.notOk },
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
    budgetFigure(budget, monthSpend, canOpen),
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

function budgetFigure(
  budget: Read<BudgetSummary>,
  monthSpend: Read<WindowSpend>,
  canOpen: { usage: boolean; budgetSetting: boolean },
): OperatingFigure {
  if (budget.state === "failed" || monthSpend.state === "failed")
    return { id: "budget", state: "unreadable", basis: "month" };
  const summary = budget.value;
  const percent = budgetPercent(summary);
  const pressure = budgetPressure(summary);
  const { calls, cost } = monthSpend.value;
  const href = canOpen.usage ? usageHref() : null;
  if (cost !== null && calls !== 0) {
    const money = { currency: cost.currency, unpricedCalls: cost.unpricedCalls };
    if (summary.budgetTokens === null)
      return {
        id: "budget",
        state: "value",
        value: cost.amount,
        href,
        basis: "month",
        money,
        uncapped: true,
      };
    if (percent === null || pressure === null)
      return { id: "budget", state: "unreadable", basis: "month" };
    return {
      id: "budget",
      state: "value",
      value: cost.amount,
      href,
      basis: "month",
      money,
      budget: {
        percent,
        budgetTokens: summary.budgetTokens,
        remainingTokens: summary.remainingTokens,
        pressure,
      },
    };
  }
  if (summary.budgetTokens === null)
    return {
      id: "budget",
      state: "uncapped",
      href: canOpen.budgetSetting ? settingsHref(BUDGET_SETTING) : null,
      basis: "month",
    };
  if (percent === null || pressure === null)
    return { id: "budget", state: "unreadable", basis: "month" };
  return {
    id: "budget",
    state: "value",
    value: percent,
    href,
    basis: "month",
    budget: {
      percent,
      budgetTokens: summary.budgetTokens,
      remainingTokens: summary.remainingTokens,
      pressure,
    },
  };
}
