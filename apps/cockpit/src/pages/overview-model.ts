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

export type HealthDigest = components["schemas"]["OperatorHealthDigest"];
export type FailureGroup = HealthDigest["failure_groups"][number];
type Execution = components["schemas"]["Execution"];

export interface WaitingSummary {
  total: number;
  /** Age of the oldest position, in whole days. */
  oldestDays: number;
  /** Positions the digest flags as stuck — old enough to be an incident. */
  stuckCount: number;
}

export function waitingSummary(digest: HealthDigest): WaitingSummary {
  const items = digest.patch_candidates.items;
  return {
    // The digest's `pending` is an exact count; `items` is capped. Never
    // report the capped length as the total.
    total: digest.patch_candidates.pending,
    oldestDays: items.reduce((days, item) => Math.max(days, item.age_days), 0),
    stuckCount: items.filter((item) => item.stuck).length,
  };
}

export interface PartitionedFailures {
  /** Failures from scheduled or mixed traffic — the real operating picture. */
  incidents: FailureGroup[];
  /** Failures from authoring and manual trial runs. */
  trials: FailureGroup[];
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
    incidents: sorted.filter((group) => group.origin === "scheduled" || group.origin === "mixed"),
    trials: sorted.filter((group) => group.origin === "authoring" || group.origin === "manual"),
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
