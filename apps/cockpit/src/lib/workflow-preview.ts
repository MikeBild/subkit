export type WorkflowPreviewSource =
  | { source: "draft"; definition: Record<string, unknown> }
  | { source: "step"; step: Record<string, unknown> };

export function workflowPreviewRequest(source: WorkflowPreviewSource) {
  return { ...source, hold_writes: true as const };
}

export function workflowPreviewSucceeded(result: Record<string, unknown>): boolean {
  return result.status === "succeeded";
}
