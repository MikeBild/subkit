import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { MentionCandidate } from "./mention-picker.tsx";

export type { MentionCandidate } from "./mention-picker.tsx";

type WorkflowMentionSource = Partial<
  Pick<components["schemas"]["WorkflowListItem"], "id" | "slug" | "name">
>;
type ExecutionMentionSource = Partial<
  Pick<components["schemas"]["ExecutionListItem"], "id" | "workflow_name">
>;

interface MentionCatalogClient {
  listWorkflows(query: { limit: number }): Promise<{ items: readonly WorkflowMentionSource[] }>;
  listExecutions(query: { limit: number }): Promise<{ items: readonly ExecutionMentionSource[] }>;
}

function nonEmptyString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function workflowMentionCandidates(
  items: readonly WorkflowMentionSource[],
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
  items: readonly ExecutionMentionSource[],
): MentionCandidate[] {
  return items.flatMap((item) => {
    const id = nonEmptyString(item.id);
    if (!id) return [];
    return [
      {
        value: `execution:${id}`,
        label: nonEmptyString(item.workflow_name) ?? id,
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
