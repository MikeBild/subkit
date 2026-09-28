import { auditHref, connectorsHref, runsHref } from "@/app/links";

// The operations bar on the Übersicht: four figures, each one link into the
// list it counts over the same window. Nutzung's runtime table reads its
// windows from here too — one definition of a window, not two.

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

export interface RunTotals {
  executions: number | null;
  successRatePercent: number | null;
  /** Runs of the window that ended `failed` — what the success rate's link lists. */
  failedRuns: number | null;
}

const SUCCESS_STATUSES = ["completed", "succeeded", "success"] as const;

/** The window's run count and success rate. Each is `null` when the engine did not send it. */
export function runTotals(envelope: unknown): RunTotals {
  const totals = isRecord(envelope) && isRecord(envelope.totals) ? envelope.totals : {};
  const executionsEnvelope = isRecord(totals.executions) ? totals.executions : {};
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
    successRatePercent:
      count !== null && count > 0 && succeeded !== null
        ? Math.round((succeeded / count) * 100)
        : null,
    failedRuns: byStatus ? (numberOrNull(byStatus.failed) ?? 0) : null,
  };
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
export function repairStatsEndpoint(bounds: WindowBounds): string {
  return `/v1/stats/events?class=self_healing&group_by=action&${windowQuery(bounds)}`;
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

/** The four figures, in reading order. The bar always holds all four. */
export const OPERATING_FIGURE_IDS = [
  "runs",
  "successRate",
  "connectorHealth",
  "repairRate",
] as const;
export type OperatingFigureId = (typeof OPERATING_FIGURE_IDS)[number];

/** A read the figures depend on: its answer, or that it could not be read. */
export type Read<T> = { state: "answered"; value: T } | { state: "failed" };

export type OperatingFigure =
  | {
      id: OperatingFigureId;
      state: "value";
      /** The raw figure: a count for runs, a whole percentage for the rates. */
      value: number;
      /**
       * The list the value counts, narrowed to the same window and filter.
       * Null where the reader may not open it, or where it would be empty — a
       * link to no failed runs beside "100 %" leads nowhere.
       */
      href: string | null;
      /** True for a state measured now rather than over the window. */
      current: boolean;
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
      current: boolean;
    };

/**
 * The operations figures, always four, in reading order, each with the one
 * list it opens.
 *
 * Every link carries the window the figure counted over, so the list it opens
 * holds the rows the number counted: the runs that started in the window, the
 * failed ones among them, the repairs decided in it. Connector health is a
 * state of now and its list is the connectors unwell now.
 *
 * A figure with nothing to say says so — no runs in the window, no enabled
 * connector, no decided repair — and never reads 0 behind a link. A read that
 * FAILED is not "nothing to say": the figure is unreadable, with a retry.
 *
 * Nothing here is a task — what needs someone is the attention list below the
 * bar, and the bar repeats none of it.
 */
export function operatingFigures(input: {
  bounds: WindowBounds;
  totals: Read<RunTotals>;
  /** Null where the reader may not read connectors at all. */
  connectors: Read<{ enabled: number | null; notOk: number | null }> | null;
  repairs: Read<RepairTotals | null>;
  canOpen: { runs: boolean; connectors: boolean; audit: boolean };
}): OperatingFigure[] {
  const { bounds, totals, connectors, repairs, canOpen } = input;
  const window = { startedFrom: bounds.from, startedTo: bounds.to };

  let runs: OperatingFigure;
  let successRate: OperatingFigure;
  if (totals.state === "failed") {
    runs = { id: "runs", state: "unreadable", current: false };
    successRate = { id: "successRate", state: "unreadable", current: false };
  } else if (totals.value.executions !== null && totals.value.executions > 0) {
    const { executions, failedRuns, successRatePercent } = totals.value;
    runs = {
      id: "runs",
      state: "value",
      value: executions,
      href: canOpen.runs ? runsHref(window) : null,
      current: false,
    };
    successRate =
      successRatePercent === null
        ? { id: "successRate", state: "none", current: false }
        : {
            id: "successRate",
            state: "value",
            value: successRatePercent,
            href:
              canOpen.runs && failedRuns !== null && failedRuns > 0
                ? runsHref({ ...window, status: "failed" })
                : null,
            current: false,
          };
  } else {
    runs = { id: "runs", state: "none", current: false };
    successRate = { id: "successRate", state: "none", current: false };
  }

  let connectorHealth: OperatingFigure;
  if (connectors === null) {
    connectorHealth = { id: "connectorHealth", state: "not_permitted", current: true };
  } else if (connectors.state === "failed") {
    connectorHealth = { id: "connectorHealth", state: "unreadable", current: true };
  } else if (
    connectors.value.enabled !== null &&
    connectors.value.enabled > 0 &&
    connectors.value.notOk !== null
  ) {
    const { enabled, notOk } = connectors.value;
    const healthy = Math.max(enabled - notOk, 0);
    connectorHealth = {
      id: "connectorHealth",
      state: "value",
      value: Math.round((healthy / enabled) * 100),
      href: canOpen.connectors && notOk > 0 ? connectorsHref({ health: "not_ok" }) : null,
      current: true,
    };
  } else {
    connectorHealth = { id: "connectorHealth", state: "none", current: true };
  }

  let repairRate: OperatingFigure;
  if (repairs.state === "failed") {
    repairRate = { id: "repairRate", state: "unreadable", current: false };
  } else if (repairs.value && repairs.value.decided > 0) {
    repairRate = {
      id: "repairRate",
      state: "value",
      value: Math.round((repairs.value.applied / repairs.value.decided) * 100),
      href: canOpen.audit
        ? auditHref({
            scope: "all",
            actions: DECIDED_REPAIR_ACTIONS,
            tsFrom: bounds.from,
            tsTo: bounds.to,
          })
        : null,
      current: false,
    };
  } else {
    repairRate = { id: "repairRate", state: "none", current: false };
  }

  return [runs, successRate, connectorHealth, repairRate];
}
