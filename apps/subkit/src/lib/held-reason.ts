const HELD_REASON_LINES: Readonly<Record<string, string>> = {
  execution_authority_required: "This workflow needs your approval before it can run.",
  execution_authority_expired:
    "The approval for this workflow has expired. Approve it again to let it run.",
  execution_authority_exhausted:
    "The approved number of runs is used up. Approve it again to let it run.",
  execution_authority_revoked:
    "The approval for this workflow was revoked. Approve it again to let it run.",
  execution_authority_changed:
    "The workflow changed since it was approved. Review and approve the new version.",
  input_required: "This run is waiting for information from you.",
};

export const HELD_REASONS: readonly string[] = Object.keys(HELD_REASON_LINES);

export function heldReasonLine(reason: string | null | undefined): string | null {
  if (!reason || !Object.hasOwn(HELD_REASON_LINES, reason)) return null;
  return HELD_REASON_LINES[reason] ?? null;
}
