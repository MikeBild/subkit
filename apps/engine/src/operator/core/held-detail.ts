const HELD_DETAIL: Readonly<Record<string, string>> = {
  execution_authority_required:
    "No approval covers the current version, so scheduled runs wait. Review and approve the workflow to start them again. Nothing has run since the hold.",
  execution_authority_unavailable:
    "The approval has expired, is used up or was revoked, so scheduled runs wait. Renew the approval to start them again. Nothing has run since the hold.",
  input_required:
    "The schedule has no input for a required field, so scheduled runs wait. Add the missing input to start them again.",
};

export function heldDetail(reason_code: string | null | undefined): string | null {
  const code = String(reason_code);
  return Object.hasOwn(HELD_DETAIL, code) ? (HELD_DETAIL[code] as string) : null;
}

export function heldCauseClass(
  reason_code: string | null | undefined,
): "authority_mismatch" | null {
  return reason_code?.startsWith("execution_authority_") ? "authority_mismatch" : null;
}
