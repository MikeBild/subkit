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
