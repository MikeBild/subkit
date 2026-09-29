// The Übersicht's operations figures, over one window, asked once.
//
// Four of the cockpit's six operations figures: runs in the window, their
// success rate, the connectors healthy now, and the share of repairs decided
// in the window that were applied (cost and budget are read from the LLM
// stats and the status route). They are read over the aggregates and the list
// service behind `GET /v1/stats/executions`, `GET /v1/stats/events` and
// `GET /v1/connectors`, with the same definitions, and each figure names the
// list it counts so a reader can open exactly those rows.
//
// One definition, every surface: `GET /v1/stats/operating-figures`, the MCP
// tool `get_operating_figures`, the cockpit's operations bar, and the
// operational overview's success and repair ratios (and so the Prometheus
// gauges projected from it, over the last 24 hours) all answer from here.
//
// Read-only: no audit row, no tracker advanced.

import { AuditAction } from "../audit/index.ts";
import { listConnectors } from "../connectors/service.ts";
import type { Db } from "../db/client.ts";
import { aggregateAudit } from "../stats/aggregate-audit.ts";
import { aggregateExecutions } from "../stats/aggregate-executions.ts";
import { statsBucketFor } from "../stats/llm-cost.ts";

export const OPERATING_FIGURES_SCHEMA_VERSION = "operating-figures.v1" as const;

/**
 * The audit verbs a decided repair leaves: approved by a person, applied on its
 * own, or rejected. The rate is over exactly these, and its link opens exactly
 * these — the cockpit's `DECIDED_REPAIR_ACTIONS` names the same three.
 */
export const DECIDED_REPAIR_ACTIONS = [
  AuditAction.PATCH_CANDIDATE_APPROVED,
  AuditAction.PATCH_CANDIDATE_AUTO_APPLIED,
  AuditAction.PATCH_CANDIDATE_REJECTED,
] as const;
const APPLIED_REPAIR_ACTIONS = new Set<string>([
  AuditAction.PATCH_CANDIDATE_APPROVED,
  AuditAction.PATCH_CANDIDATE_AUTO_APPLIED,
]);

/** The windows the cockpit's bar offers, as hours back from now. */
export const OPERATING_WINDOWS = { "24h": 24, "7d": 7 * 24, "30d": 30 * 24 } as const;
export type OperatingWindow = keyof typeof OPERATING_WINDOWS;

export interface OperatingFigures {
  schema_version: typeof OPERATING_FIGURES_SCHEMA_VERSION;
  /** Runs and repairs count over [from, to); connector health is a state of now. */
  window: { from: string; to: string };
  runs: {
    /** Runs that started in the window. */
    total: number;
    succeeded: number;
    failed: number;
    /** Runs of the window that have ended (not queued, not running). */
    finished: number;
    /**
     * Whole percent of the FINISHED runs that succeeded; null when none has
     * ended. A run still in flight is neither a success nor a failure — counted
     * against the total it lowered the rate and the health score every time
     * work was merely under way.
     */
    success_rate_percent: number | null;
    /** The runs counted, and the failed ones among them (null when there are none). */
    href: string;
    failed_href: string | null;
  };
  connectors: {
    /** Enabled, not deleted — the connectors the health figure counts. */
    enabled: number;
    /** Counted, and in any health state but `ok`. */
    not_ok: number;
    /** Whole percent of `enabled` that are healthy; null when none is enabled. */
    healthy_percent: number | null;
    href: string | null;
  };
  repairs: {
    decided: number;
    applied: number;
    /** Whole percent of `decided` that were applied; null when none was decided. */
    applied_percent: number | null;
    href: string;
  };
}

function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

function cockpitHref(path: string, query: Record<string, string>): string {
  return `/cockpit${path}?${new URLSearchParams(query).toString()}`;
}

/** The longest window the figures are read over — the stats routes' day-bucket cap. */
export const OPERATING_WINDOW_MAX_MS = 366 * 86_400_000;

/**
 * `[from, to)` from what a caller asked: explicit bounds (`to` defaults to
 * now), else a named window ending now (default `24h`). One resolver for the
 * route and the MCP tool, so the same arguments count the same window.
 */
export function resolveOperatingBounds(
  input: {
    window?: OperatingWindow | undefined;
    from?: string | undefined;
    to?: string | undefined;
  },
  now: Date,
): { ok: true; from: Date; to: Date } | { ok: false; reason: string } {
  const to = input.to ? new Date(input.to) : now;
  const from = input.from
    ? new Date(input.from)
    : new Date(to.getTime() - OPERATING_WINDOWS[input.window ?? "24h"] * 3_600_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { ok: false, reason: "from and to must be ISO 8601 instants" };
  }
  if (to.getTime() <= from.getTime()) return { ok: false, reason: "to must be after from" };
  if (to.getTime() - from.getTime() > OPERATING_WINDOW_MAX_MS) {
    return { ok: false, reason: "the window spans at most 366 days" };
  }
  return { ok: true, from, to };
}

/**
 * The four figures over `[from, to)`. Tenant-wide, like the three routes they
 * mirror; the caller gates the read (`stats:read`).
 */
export async function readOperatingFigures(
  db: Db,
  tenantId: string,
  bounds: { from: Date; to: Date },
): Promise<OperatingFigures> {
  const bucket = statsBucketFor(bounds.from, bounds.to);
  const window = { tenantId, bucket, from: bounds.from, to: bounds.to, tz: "UTC" } as const;
  const [executions, repairs, enabled, notOk] = await Promise.all([
    aggregateExecutions(db, { ...window, groupBy: [] }),
    aggregateAudit(db, {
      ...window,
      actions: [...DECIDED_REPAIR_ACTIONS],
      groupBy: ["action"],
    }),
    listConnectors(tenantId, { enabled: true, limit: 1 }, db),
    listConnectors(tenantId, { health: "not_ok", limit: 1 }, db),
  ]);

  const total = executions.totals.executions.count;
  const byStatus = executions.totals.executions.by_status;
  const succeeded = byStatus.succeeded ?? 0;
  const failed = byStatus.failed ?? 0;
  const finished = Math.max(total - (byStatus.queued ?? 0) - (byStatus.running ?? 0), 0);

  let decided = 0;
  let applied = 0;
  for (const group of repairs.groups) {
    const calls = group.totals.calls.total;
    decided += calls;
    if (APPLIED_REPAIR_ACTIONS.has(group.key.action ?? "")) applied += calls;
  }

  const from = bounds.from.toISOString();
  const to = bounds.to.toISOString();
  const runWindow = { started_from: from, started_to: to };
  return {
    schema_version: OPERATING_FIGURES_SCHEMA_VERSION,
    window: { from, to },
    runs: {
      total,
      succeeded,
      failed,
      finished,
      success_rate_percent: percent(succeeded, finished),
      href: cockpitHref("/runs", runWindow),
      failed_href: failed > 0 ? cockpitHref("/runs", { status: "failed", ...runWindow }) : null,
    },
    connectors: {
      enabled: enabled.total,
      not_ok: notOk.total,
      healthy_percent: percent(Math.max(enabled.total - notOk.total, 0), enabled.total),
      href: notOk.total > 0 ? cockpitHref("/connectors", { health: "not_ok" }) : null,
    },
    repairs: {
      decided,
      applied,
      applied_percent: percent(applied, decided),
      href: cockpitHref("/audit", {
        scope: "all",
        action: DECIDED_REPAIR_ACTIONS.join(","),
        ts_from: from,
        ts_to: to,
      }),
    },
  };
}
