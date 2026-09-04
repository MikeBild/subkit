import type { MentionCandidate } from "./mention-picker.tsx";

export type { MentionCandidate } from "./mention-picker.tsx";

interface MentionCatalogClient {
  listWorkflows(query: { limit: number }): Promise<{ items: Record<string, unknown>[] }>;
  listExecutions(query: { limit: number }): Promise<{ items: Record<string, unknown>[] }>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function workflowMentionCandidates(
  items: readonly Record<string, unknown>[],
): MentionCandidate[] {
  return items.flatMap((item) => {
    const id = nonEmptyString(item.id);
    if (!id) return [];
    const slug = nonEmptyString(item.slug);
    return [
      {
        value: `workflow:${slug ?? id}`,
        label: nonEmptyString(item.name) ?? slug ?? id,
        kind: "workflow" as const,
      },
    ];
  });
}

export function executionMentionCandidates(
  items: readonly Record<string, unknown>[],
): MentionCandidate[] {
  return items.flatMap((item) => {
    const id = nonEmptyString(item.id);
    if (!id) return [];
    return [
      {
        value: `execution:${id}`,
        label: nonEmptyString(item.workflow_name) ?? nonEmptyString(item.workflow_slug) ?? id,
        kind: "execution" as const,
      },
    ];
  });
}

export async function loadMentionCandidates(
  client: MentionCatalogClient,
  allowed: ReadonlySet<string>,
): Promise<MentionCandidate[]> {
  const workflows = allowed.has("workflow:read")
    ? client.listWorkflows({ limit: 50 })
    : Promise.resolve({ items: [] });
  const executions = allowed.has("execution:read")
    ? client.listExecutions({ limit: 20 })
    : Promise.resolve({ items: [] });
  const [workflowResult, executionResult] = await Promise.allSettled([workflows, executions]);
  return [
    ...(workflowResult.status === "fulfilled"
      ? workflowMentionCandidates(workflowResult.value.items)
      : []),
    ...(executionResult.status === "fulfilled"
      ? executionMentionCandidates(executionResult.value.items)
      : []),
  ];
}
