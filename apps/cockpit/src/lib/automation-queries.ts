// The reads a workflow's automation state rests on — and the one way to make
// them all look again.
//
// The page polls the approvals and the verified status, but an act changes
// more than the read it was made through: an approval lifts a hold and
// changes the diagnosis, a revocation takes an approval and the call block's
// "may run" away, a run spends one of the approved runs. Each act used to
// invalidate its own handful of keys, so the panel could show yesterday's
// verdict beside today's list. Every act now names this one list.

import type { QueryClient, QueryKey } from "@tanstack/react-query";

export function automationQueryKeys(workflowId: string): QueryKey[] {
  return [
    ["workflow-authorities", workflowId],
    ["workflow-automation-status", workflowId],
    ["workflow-diagnosis", workflowId],
    ["workflow", workflowId, "schedules"],
    ["workflow-invocation", workflowId],
    ["workflow-draft-version", workflowId],
    ["workflow-grant-context", workflowId],
    ["chat-automation-workflow", workflowId],
    ["catalog-detail", "workflows", workflowId],
  ];
}

/** After anything that may change whether the workflow may run on its own. */
export async function invalidateWorkflowAutomation(
  client: QueryClient,
  workflowId: string,
): Promise<void> {
  await Promise.all(
    automationQueryKeys(workflowId).map((queryKey) => client.invalidateQueries({ queryKey })),
  );
}

/** How often a page looks again: an approval, a hold or a schedule can change under it. */
export const AUTOMATION_REFRESH_MS = 30_000;
