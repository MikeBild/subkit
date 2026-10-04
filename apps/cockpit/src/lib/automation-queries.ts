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

export async function invalidateWorkflowAutomation(
  client: QueryClient,
  workflowId: string,
): Promise<void> {
  await Promise.all(
    automationQueryKeys(workflowId).map((queryKey) => client.invalidateQueries({ queryKey })),
  );
}

export const AUTOMATION_REFRESH_MS = 30_000;
