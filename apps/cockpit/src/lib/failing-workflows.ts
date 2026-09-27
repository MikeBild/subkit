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

import { runsHref } from "@/app/links";

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
  /**
   * When the workflow next ran clean on its schedule; null while it is live.
   *
   * Optional, and read as falsy rather than compared to `null`. An engine that
   * does not report it must leave the cause on screen — `undefined === null`
   * is false, which would have filtered out every live failure instead.
   */
  resolved_at?: string | null;
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
 *
 * A group whose workflow has since run clean on its schedule is out too: there
 * is nothing left to decide, and leaving it in kept a healed installation
 * showing an open decision with no action that could close it.
 */
export function failingWorkflows(
  groups: readonly DigestFailureGroup[] | null | undefined,
): FailingWorkflow[] {
  return (groups ?? [])
    .filter((group) => group.scheduled_count > 0 && !group.resolved_at)
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
      //
      // Router-relative, WITHOUT the `/cockpit` prefix: this is handed to a
      // router `Link`, and the router already carries `/cockpit` as its base
      // (app/router.tsx). Written absolute it became `/cockpit/cockpit/runs`
      // and the one link out of a failing decision led to "page not found" —
      // the number named something and then went nowhere, which is the exact
      // defect this href exists to fix.
      //
      // `source=scheduler` because the decision is about the SCHEDULED runs —
      // that is the filter above, `scheduled_count > 0`. Without it the link
      // handed back every failed run of the workflow, authoring trials
      // included, so the list the reader landed on could not add up to the
      // count the decision showed. The runs page validates the parameter
      // (`isKnownRequestSource` in pages/runs-model.ts), and `scheduler` is
      // one it knows. It goes on the unnamed branch too: a group with no
      // workflow name is the one where an unfiltered list explains least.
      //
      // `workflow_id` where the group knows it: a name search also matches
      // every workflow whose name merely contains this one's, and a renamed
      // workflow not at all. The name stays beside it because the search box
      // is what tells the reader, in words, which workflow the list is about.
      runs_href: runsHref({
        workflowId: group.workflow_id,
        status: "failed",
        source: "scheduler",
        q: group.workflow_name,
      }),
    }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
}
