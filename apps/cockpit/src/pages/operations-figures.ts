import { auditHref, connectorsHref, runsHref, settingsHref, usageHref } from "@/app/links";
import {
  type BudgetSummary,
  budgetPercent,
  budgetPressure,
  type ConsumptionAxis,
  type WindowCost,
  windowCost,
} from "./usage-model";

// The operations bar on the Übersicht: six figures, each one link into the
// list or page that counts the same thing. Nutzung reads its windows from
// here too — one definition of a window, not two.

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The windows figures and the runtime table can be read over. The engine
 * takes any window within its bucket caps (stats/bucket-window.ts): a day in
 * hours, a week and a month in days.
 */
export const STATS_WINDOWS = ["24h", "7d", "30d"] as const;
export type StatsWindow = (typeof STATS_WINDOWS)[number];

const WINDOW_SHAPE: Record<StatsWindow, { bucket: "hour" | "day"; hours: number }> = {
  "24h": { bucket: "hour", hours: 24 },
  "7d": { bucket: "day", hours: 7 * 24 },
  "30d": { bucket: "day", hours: 30 * 24 },
};

/** Whether the window's table has one row per hour or per day. */
export function windowBucket(window: StatsWindow): "hour" | "day" {
  return WINDOW_SHAPE[window].bucket;
}

/**
 * One window as two fixed instants. Fixed, not "the last 7 days" re-read at
 * every request: the figures and the lists they link to must count over the
 * very same bounds, and a window that slid between the stats query and the
 * click would count different runs.
 */
export interface WindowBounds {
  window: StatsWindow;
  from: string;
  to: string;
}

export function windowBounds(window: StatsWindow, now = new Date()): WindowBounds {
  const from = new Date(now.getTime() - WINDOW_SHAPE[window].hours * 3_600_000);
  return { window, from: from.toISOString(), to: now.toISOString() };
}

/** The window an address names (`?window=24h`), or Nutzung's default of thirty days. */
export function usageWindowFromUrl(search: string): StatsWindow {
  const raw = new URLSearchParams(search).get("window");
  return (STATS_WINDOWS as readonly string[]).includes(raw ?? "") ? (raw as StatsWindow) : "30d";
}

/** A window as the stats routes take it: its bucket and both bounds. */
function windowQuery(bounds: WindowBounds): string {
  return [
    `bucket=${WINDOW_SHAPE[bounds.window].bucket}`,
    `from=${encodeURIComponent(bounds.from)}`,
    `to=${encodeURIComponent(bounds.to)}`,
  ].join("&");
}

/** The runs over one window. The engine rejects a call without a window. */
export function executionStatsEndpoint(bounds: WindowBounds): string {
  return `/v1/stats/executions?${windowQuery(bounds)}`;
}

/**
 * Model calls over one window, and what they cost. Without an axis the engine
 * answers with the window's totals and its `cost` alone — what the cost figure
 * needs; Nutzung asks the same window with an axis for its breakdown, so the
 * figure and the page it links to read one query shape over the same bounds.
 */
export function llmStatsEndpoint(bounds: WindowBounds, axis?: ConsumptionAxis): string {
  return `/v1/stats/llm?${windowQuery(bounds)}${axis ? `&group_by=${axis}` : ""}`;
}

/** The calendar month's tokens against the cap — the budget figure's one read. */
export const STATUS_ENDPOINT = "/v1/status";

export interface WindowSpend {
  /** Model calls in the window; `null` when the engine did not send the count. */
  calls: number | null;
  /** The priced amount, or `null` when no call of the window had a price. */
  cost: WindowCost | null;
}

/** The window's calls and money, from the `/v1/stats/llm` envelope. */
export function windowSpend(envelope: unknown): WindowSpend {
  const totals = isRecord(envelope) && isRecord(envelope.totals) ? envelope.totals : {};
  const calls = isRecord(totals.calls) ? numberOrNull(totals.calls.total) : null;
  return { calls, cost: windowCost(envelope) };
}

/**
 * The runs, success rate, connector health and repair rate over one window,
 * as the engine counts them — one read, the one `GET /v1/stats/operating-figures`
 * answers for the MCP tool `get_operating_figures` and the operational
 * overview too. The bar does not count on its own: a second copy of a
 * definition is how two surfaces come to quote two rates for one question.
 */
export function operatingFiguresEndpoint(bounds: WindowBounds): string {
  return `/v1/stats/operating-figures?from=${encodeURIComponent(bounds.from)}&to=${encodeURIComponent(bounds.to)}`;
}

/** What the four engine-counted figures are made of. */
export interface OperatingCounts {
  runs: {
    /** Runs that started in the window. */
    total: number;
    /** Runs of the window that ended `failed` — what the success rate's link lists. */
    failed: number;
    /** The engine's whole percent; null when no run started. */
    successRatePercent: number | null;
  };
  connectors: { enabled: number; notOk: number; healthyPercent: number | null };
  repairs: { decided: number; appliedPercent: number | null };
}

function countOf(value: unknown): number | null {
  const n = numberOrNull(value);
  return n !== null && n >= 0 ? n : null;
}

/** The counts from the `operating-figures.v1` envelope, or null when it is not one. */
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

/**
 * The audit verbs a decided repair leaves: approved by a person, applied on
 * its own, or rejected. The engine's repair rate is counted over exactly these
 * (operator/operating-figures.ts, DECIDED_REPAIR_ACTIONS), and the link opens
 * exactly these — the number and the list it leads to are the same rows.
 */
export const DECIDED_REPAIR_ACTIONS = [
  "patch_candidate.approved",
  "patch_candidate.auto_applied",
  "patch_candidate.rejected",
] as const;

/** The six figures, in reading order. The bar always holds all six. */
export const OPERATING_FIGURE_IDS = [
  "runs",
  "successRate",
  "connectorHealth",
  "repairRate",
  "cost",
  "budget",
] as const;
export type OperatingFigureId = (typeof OPERATING_FIGURE_IDS)[number];

/**
 * What a figure is measured over, said beside its label: the chosen window,
 * the state of now ("Stand jetzt"), or the calendar month ("Monat") — the
 * budget is spent against the month whichever window is chosen.
 */
export type FigureBasis = "window" | "now" | "month";

/** The setting the cap is: `tokens.monthly_budget`, where 0 means no cap. */
export const BUDGET_SETTING = "tokens.monthly_budget";

/** A read the figures depend on: its answer, or that it could not be read. */
export type Read<T> = { state: "answered"; value: T } | { state: "failed" };

export type OperatingFigure =
  | {
      id: OperatingFigureId;
      state: "value";
      /**
       * The raw figure: a count for runs, a whole percentage for the rates and
       * the budget, an amount of money for the cost.
       */
      value: number;
      /**
       * The list or page the value counts, narrowed to the same window and
       * filter. Null where the reader may not open it, or where it would be
       * empty — a link to no failed runs beside "100 %" leads nowhere.
       */
      href: string | null;
      basis: FigureBasis;
      /**
       * Cost only. `unpricedCalls > 0` makes the amount a floor ("mind."), and
       * the figure says how many calls it leaves out — never a silent partial sum.
       */
      money?: { currency: string; unpricedCalls: number };
      /** Budget only: the cap, what is left of it, and its pressure word. */
      budget?: {
        budgetTokens: number;
        remainingTokens: number | null;
        pressure: "ample" | "tightening" | "critical";
      };
    }
  | {
      id: OperatingFigureId;
      /**
       * `none`: answered, and there is nothing to count — said in words, never
       * as a tile reading 0. `unreadable`: the read failed — said so, with a
       * way to ask again, never as "nothing to report". `not_permitted`: the
       * reader may not read what the figure is made of.
       */
      state: "none" | "unreadable" | "not_permitted";
      basis: FigureBasis;
    }
  | {
      /**
       * Cost: the window had model calls and none of them had a price. Not an
       * amount of nought — that would say the window was free — but a sentence,
       * and the way to Nutzung, which names the models without a price.
       */
      id: "cost";
      state: "unpriced";
      href: string | null;
      basis: FigureBasis;
    }
  | {
      /**
       * Budget: nothing bounds the workspace (`tokens.monthly_budget` is 0).
       * Said as "kein Kontingent", with no percentage; the link is the setting,
       * for someone who may change it.
       */
      id: "budget";
      state: "uncapped";
      href: string | null;
      basis: FigureBasis;
    };

/**
 * The operations figures, always six, in reading order, each with the one
 * list or page it opens.
 *
 * Every link carries the window the figure counted over, so the list it opens
 * holds the rows the number counted: the runs that started in the window, the
 * failed ones among them, the repairs decided in it, the money spent in it
 * (Nutzung over the same window). Connector health is a state of now and its
 * list is the connectors unwell now; the budget is the calendar month's and
 * opens Nutzung, where the month is broken down.
 *
 * A figure with nothing to say says so — no runs in the window, no enabled
 * connector, no decided repair, no model call — and never reads 0 behind a
 * link. A read that FAILED is not "nothing to say": the figure is unreadable,
 * with a retry.
 *
 * Nothing here is a task — what needs someone is the attention list below the
 * bar, and the bar repeats none of it.
 */
export function operatingFigures(input: {
  bounds: WindowBounds;
  /** The engine's counts for runs, connectors and repairs; null when the answer was not one. */
  counts: Read<OperatingCounts | null>;
  /**
   * Whether the reader may read connectors. The engine answers the connector
   * totals under `stats:read`; the bar keeps saying "not permitted" to a
   * reader who could not open a single connector the figure counts.
   */
  connectorsPermitted: boolean;
  spend: Read<WindowSpend>;
  budget: Read<BudgetSummary>;
  canOpen: {
    runs: boolean;
    connectors: boolean;
    audit: boolean;
    usage: boolean;
    /** Whether the reader may change the cap — the only reason to link the setting. */
    budgetSetting: boolean;
  };
}): OperatingFigure[] {
  const { bounds, counts, connectorsPermitted, spend, budget, canOpen } = input;
  const window = { startedFrom: bounds.from, startedTo: bounds.to };
  // An answer that is not the figures is no more readable than a failed read.
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
    budgetFigure(budget, canOpen),
  ];
}

/**
 * The window's money. No model call in the window is "none" — not an amount of
 * nought behind a link. Calls without any price are "unpriced", said in words.
 * A partly priced window is a floor: the amount carries the calls it leaves out.
 */
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

/**
 * The calendar month's tokens against the cap, as a whole percentage with its
 * pressure word. No cap is "uncapped" — no percentage — and its link is the
 * setting, for someone who may change it.
 */
function budgetFigure(
  budget: Read<BudgetSummary>,
  canOpen: { usage: boolean; budgetSetting: boolean },
): OperatingFigure {
  if (budget.state === "failed") return { id: "budget", state: "unreadable", basis: "month" };
  const summary = budget.value;
  const percent = budgetPercent(summary);
  const pressure = budgetPressure(summary);
  if (summary.budgetTokens === null)
    return {
      id: "budget",
      state: "uncapped",
      href: canOpen.budgetSetting ? settingsHref(BUDGET_SETTING) : null,
      basis: "month",
    };
  // A cap without the month's consumption beside it is not a percentage.
  if (percent === null || pressure === null)
    return { id: "budget", state: "unreadable", basis: "month" };
  return {
    id: "budget",
    state: "value",
    value: percent,
    href: canOpen.usage ? usageHref() : null,
    basis: "month",
    budget: {
      budgetTokens: summary.budgetTokens,
      remainingTokens: summary.remainingTokens,
      pressure,
    },
  };
}
