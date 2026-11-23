export type HeldDetailKey =
  | "held.execution_authority_required"
  | "held.execution_authority_expired"
  | "held.execution_authority_exhausted"
  | "held.execution_authority_revoked"
  | "held.execution_authority_changed"
  | "held.input_required";

const HELD_DETAIL: Readonly<Record<string, string>> = {
  execution_authority_required:
    "No approval covers the current version, so scheduled runs wait. Review and approve the workflow to start them again. Nothing has run since the hold.",
  execution_authority_expired:
    "The approval has expired, so scheduled runs wait. Renew the approval to start them again. Nothing has run since the hold.",
  execution_authority_exhausted:
    "The approval is used up: every approved run has started, so scheduled runs wait. Approve more runs to start them again. Nothing has run since the hold.",
  execution_authority_revoked:
    "The approval was revoked, so scheduled runs wait. Approve the workflow again to start them. Nothing has run since the hold.",
  execution_authority_changed:
    "The workflow would now do something the approval does not cover, so scheduled runs wait. Review what changed and approve it to start them again. Nothing has run since the hold.",
  input_required:
    "The schedule has no input for a required field, so scheduled runs wait. Add the missing input to start them again.",
};

export function heldDetail(reason_code: string | null | undefined): string | null {
  const code = String(reason_code);
  return Object.hasOwn(HELD_DETAIL, code) ? (HELD_DETAIL[code] as string) : null;
}

export function heldDetailKey(reason_code: string | null | undefined): HeldDetailKey | null {
  const code = String(reason_code);
  return Object.hasOwn(HELD_DETAIL, code) ? (`held.${code}` as HeldDetailKey) : null;
}

export function heldCauseClass(
  reason_code: string | null | undefined,
): "authority_mismatch" | null {
  return reason_code?.startsWith("execution_authority_") ? "authority_mismatch" : null;
}
