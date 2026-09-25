// A workflow that was approved and keeps failing is a decision nobody was told
// about.
//
// The decisions page listed workflows that could not START — held for want of
// an approval. It never listed the opposite case: an approved, scheduled
// workflow that runs on time and fails every time. On one production
// installation that was `company-product-analytics-hourly`: a live approval, 77
// failed runs in thirty days, 76 of them the same step answering 404. Nothing
// in the cockpit said so. The number that came closest, "production incidents",
// linked to a list of eleven thousand runs.
//
// The engine already groups these failures for the operator health digest —
// workflow, step, error code, how often, since when, and a one-sentence cause.
// This turns those groups into the decisions they are, and keeps out the ones
// that are not: an authoring trial that failed is feedback, not an incident.

export interface DigestFailureGroup {
  signature: string;
  workflow_id: string | null;
  workflow_name: string | null;
  step_key: string | null;
  error_code: string | null;
  origin: string;
  count: number;
  /** How many of these runs the scheduler started. */
  scheduled_count: number;
  last_seen: string;
  cause: string;
  guidance: string | null;
}

export interface FailingWorkflow {
  /** Stable across refreshes: the engine's own grouping key. */
  key: string;
  workflow_id: string | null;
  workflow_name: string | null;
  step_key: string | null;
  count: number;
  last_seen: string;
  cause: string;
  guidance: string | null;
  /** The failed runs of this workflow, and only those. */
  runs_href: string;
}

/**
 * The scheduled failure groups, worst first.
 *
 * The filter is whether the scheduler ever started one of these runs: that
 * happens because a human approved it and the clock came round, so its failure
 * is an operational fact. A failed authoring trial is someone trying something
 * out, and it stays out.
 *
 * Not `origin`, which collapses to "mixed" as soon as a group holds more than
 * one kind of run — so one manual retry of a failing schedule used to delete
 * the decision from this list while the schedule went on failing.
 */
export function failingWorkflows(
  groups: readonly DigestFailureGroup[] | null | undefined,
): FailingWorkflow[] {
  return (groups ?? [])
    .filter((group) => group.scheduled_count > 0)
    .map((group) => ({
      key: group.signature,
      workflow_id: group.workflow_id,
      workflow_name: group.workflow_name,
      step_key: group.step_key,
      count: group.count,
      last_seen: group.last_seen,
      cause: group.cause,
      guidance: group.guidance,
      // The name, because the runs list searches by it — an id would match
      // nothing there, and a link that lands on everything is what this
      // replaces.
      runs_href: group.workflow_name
        ? `/cockpit/runs?status=failed&q=${encodeURIComponent(group.workflow_name)}`
        : "/cockpit/runs?status=failed",
    }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
}
