export type WorkflowPreviewSource =
  | { source: "draft"; definition: Record<string, unknown> }
  | { source: "step"; step: Record<string, unknown> };

/** Cockpit previews never opt into live writes, even on a retry. */
export function workflowPreviewRequest(source: WorkflowPreviewSource) {
  return { ...source, hold_writes: true as const };
}

export function workflowPreviewSucceeded(result: Record<string, unknown>): boolean {
  // HTTP 200 describes a completed request, not a successful workflow.
  return result.status === "succeeded";
}
