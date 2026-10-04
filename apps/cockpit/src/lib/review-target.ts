export interface ReviewTarget {
  kind: "prepared" | "active";
  version_id: string;
  version: number | null;
  active_version: number | null;
  activation?: { expected_current_version_id: string | null };
}

interface WorkflowIdentity {
  current_version_id?: string | null;
  draft_version_id?: string | null;
  current_version?: number | null;
}

export function reviewTarget(
  workflow: WorkflowIdentity | null | undefined,
  draft?: { version_id: string; version: number } | null,
): ReviewTarget | null {
  if (!workflow) return null;
  const active_version = workflow.current_version ?? null;
  const prepared =
    typeof workflow.draft_version_id === "string" &&
    workflow.draft_version_id !== workflow.current_version_id
      ? workflow.draft_version_id
      : null;
  if (prepared)
    return {
      kind: "prepared",
      version_id: prepared,
      version: draft?.version_id === prepared ? draft.version : null,
      active_version,
      activation: { expected_current_version_id: workflow.current_version_id ?? null },
    };
  if (typeof workflow.current_version_id === "string")
    return {
      kind: "active",
      version_id: workflow.current_version_id,
      version: active_version,
      active_version,
    };
  return null;
}
