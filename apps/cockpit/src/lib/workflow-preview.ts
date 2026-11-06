import type { components } from "@cli-core/engine-api/openapi";

type Schemas = components["schemas"];

export type WorkflowPreviewDraft = Schemas["ExecutionRunDraftDefinition"];

export type WorkflowPreviewSource =
  | { source: "draft"; definition: WorkflowPreviewDraft; input?: Record<string, unknown> }
  | { source: "step"; step: Schemas["ExecutionRunStep"] };

export function workflowPreviewRequest(
  source: WorkflowPreviewSource,
): Schemas["ExecutionRunDraftBody"] | Schemas["ExecutionRunStepBody"] {
  return { ...source, hold_writes: true as const };
}

export function workflowPreviewDefinition(
  definition: Record<string, unknown>,
  steps: readonly Record<string, unknown>[],
): WorkflowPreviewDraft {
  return {
    ...definition,
    name: typeof definition.name === "string" ? definition.name : "",
    steps: [...steps],
  };
}
