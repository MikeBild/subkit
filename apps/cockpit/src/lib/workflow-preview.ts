export type WorkflowPreviewSource =
  | { source: "draft"; definition: Record<string, unknown>; input?: Record<string, unknown> }
  | { source: "step"; step: Record<string, unknown> };

export function workflowPreviewRequest(source: WorkflowPreviewSource) {
  return { ...source, hold_writes: true as const };
}

export function workflowPreviewDefinition(
  definition: Record<string, unknown>,
  steps: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return { ...definition, steps };
}
