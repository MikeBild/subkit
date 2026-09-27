import type { components } from "@/api/schema";

// What an overview owes a reader: the operating picture, not a second copy of
// the work queue.
//
// This page used to render the full list of proposed fixes — the same rows as
// the decisions page, non-actionable, and titled differently, so the two pages
// disagreed about what the same candidate was called. Whatever else an overview
// is, it is not a place to read the queue and then be unable to decide it.
//
// What it owes instead: how many are waiting and how long the oldest has been
// there (one line, linking to where they can be decided), what is failing and
// whether that is real, and what actually ran recently.
//
// The waiting numbers are NOT derived here. The digest carries only patch
// candidates and its own `stuck` flag, so every number this file could offer
// about the queue would be a third of it: `countOpenDecisions` in
// decisions-model.ts owns that count for every surface, and this file keeps
// what the digest genuinely owns — failure groups, risks, the all-clear.

export type HealthDigest = components["schemas"]["OperatorHealthDigest"];
export type FailureGroup = HealthDigest["failure_groups"][number];
type Execution = components["schemas"]["Execution"];

export interface PartitionedFailures {
  /** Failures from scheduled or mixed traffic — the real operating picture. */
  incidents: FailureGroup[];
  /** Failures from authoring and manual trial runs. */
  trials: FailureGroup[];
  /**
   * Scheduled failures whose workflow has run clean on its schedule since.
   *
   * Its own bucket, not folded into `trials`: a production incident that ended
   * is not an experiment, and filing it as one would label a real outage as
   * something somebody was trying out. It is history — shown as such, counted
   * as neither.
   */
  recovered: FailureGroup[];
}

/**
 * Separate real incidents from trial runs.
 *
 * `origin` tells them apart, and merging them inflates the picture badly: a
 * person building a workflow can produce dozens of failed trial runs in an
 * afternoon, and an overview that counts those alongside a scheduled job
 * failing nightly is reporting a crisis that is not happening.
 */
export function partitionFailures(groups: readonly FailureGroup[]): PartitionedFailures {
  const sorted = [...groups].sort((a, b) => b.count - a.count);
  return {
    // One rule, the same one the decisions queue and the overview tile use:
    // did the scheduler start any of these runs. Reading `origin` here counted
    // a group that was tried by hand AND in the editor as an incident, because
    // two kinds of trial run also merge to "mixed".
    incidents: sorted.filter((group) => group.scheduled_count > 0 && !group.resolved_at),
    trials: sorted.filter((group) => group.scheduled_count === 0),
    recovered: sorted.filter((group) => group.scheduled_count > 0 && Boolean(group.resolved_at)),
  };
}

export interface RecentRun {
  id: string;
  name: string | null;
  status: string;
  startedAt: string | null;
  /** Wall-clock duration, or null while the run has not finished. */
  durationMs: number | null;
}

/**
 * The last handful of runs, newest first.
 *
 * There is deliberately no "next scheduled run" companion to this: the engine
 * exposes a cron expression and a timezone but computes no next-fire instant
 * anywhere, and a time this page derived itself would be a guess presented as a
 * fact.
 */
export function recentRuns(executions: readonly Execution[], limit = 8): RecentRun[] {
  return [...executions]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, limit)
    .map((execution) => ({
      id: execution.id,
      name: execution.workflow_name ?? null,
      status: execution.status,
      startedAt: execution.started_at ?? null,
      durationMs: runDurationMs(execution),
    }));
}

function runDurationMs(execution: Execution): number | null {
  if (!execution.started_at || !execution.finished_at) return null;
  const started = Date.parse(execution.started_at);
  const finished = Date.parse(execution.finished_at);
  if (Number.isNaN(started) || Number.isNaN(finished)) return null;
  return Math.max(0, finished - started);
}

/**
 * The metrics whose drilldown narrows to what the number actually counted.
 *
 * `executions.incidents_24h` is the only one. Its link carries
 * `?status=failed&source=scheduler`, which together are the metric's own
 * definition: failed runs the scheduler started, as distinct from authoring
 * trials. Every other product metric pointed at a list that cannot tell its
 * number apart from any other, so those numbers kept their value and lost
 * their link.
 */
export const ACTIONABLE_DRILLDOWNS: ReadonlySet<string> = new Set(["executions.incidents_24h"]);

/**
 * Whether this metric offers a way in.
 *
 * Being aimed correctly is necessary and not sufficient. On a live
 * installation the one surviving link sat under "production incidents: 0" and
 * opened nine hundred rows — the worst form of the defect it had survived,
 * because a reader clicks a zero expecting to be told there is nothing and is
 * handed a wall instead. A count of nothing has nothing to open.
 *
 * `null` is not zero: a metric whose value could not be read is unknown, not
 * empty, and an unknown offers no way in either.
 */
export function metricOffersDrilldown(id: string, value: number | null | undefined): boolean {
  return ACTIONABLE_DRILLDOWNS.has(id) && (value ?? 0) > 0;
}

/**
 * The status line under a tile's value, or nothing when it would repeat it.
 *
 * "Betriebszustand" printed "Gesund" as its value and "Gesund" again as its
 * status; "Datenstand" printed "Aktuell" twice. A second line that says the
 * same word is not a second fact. It stays where it adds one — "Veraltet"
 * under a measured age says what the age means.
 */
export function distinctStatus(value: string, status: string | undefined): string | undefined {
  return status && status.trim() !== value.trim() ? status : undefined;
}
