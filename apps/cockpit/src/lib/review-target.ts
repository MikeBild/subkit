// Which version an approval should judge.
//
// A held schedule sends the reader to the workflow page, and that page compiled
// the approval from `current_version_id` — the version that is running. But the
// reason a schedule is held is usually that this very version cannot be bound,
// and the repaired version is sitting right next to it as a saved draft. So the
// reader saw the old problems, had no way to reach the fix, and the only honest
// move left was to give up.
//
// Observed on three production workflows at once: each had a prepared draft one
// version ahead (14→15, 9→10, 4→5, 4→6) and each showed an approval dialog full
// of problems that the prepared version had already solved. Every workflow that
// did get approved had no pending draft at all.
//
// The chat surface always got this right ("the saved draft is the review
// target; never silently authorize the older active version"). This is that
// rule, extracted, so both surfaces decide it the same way.

export interface ReviewTarget {
  /** `prepared` means approving must also activate; `active` is the running one. */
  kind: "prepared" | "active";
  /** The version whose effects the approval compiles and the person judges. */
  version_id: string;
  /** Its number, when the caller could read it. Null only costs a nicer label. */
  version: number | null;
  /** What the schedule runs today. Null when nothing was ever activated. */
  active_version: number | null;
  /** Passed to the grant so activation and approval stay one human decision. */
  activation?: { expected_current_version_id: string | null };
}

interface WorkflowIdentity {
  current_version_id?: string | null;
  draft_version_id?: string | null;
  current_version?: number | null;
}

/**
 * The version to review, from the workflow record alone.
 *
 * The draft's body is NOT needed to decide this — the approval preview is
 * addressed by version id, which the record already carries. A caller that has
 * also loaded the draft may pass it in; that only supplies the version number
 * for the label, and a draft that no longer matches the record is ignored
 * rather than trusted.
 */
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
