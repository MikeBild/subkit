export const AUTHORITY_REFUSAL_CODES = [
  "execution_authority_expired",
  "execution_authority_exhausted",
  "execution_authority_revoked",
  "execution_authority_changed",
  "execution_authority_required",
] as const;

export type AuthorityRefusalCode = (typeof AUTHORITY_REFUSAL_CODES)[number];

export function isAuthorityRefusalCode(code: unknown): code is AuthorityRefusalCode {
  return typeof code === "string" && (AUTHORITY_REFUSAL_CODES as readonly string[]).includes(code);
}

export const AUTHORITY_HOLD_BACKFILL = {
  from: "execution_authority_unavailable",
  to: "execution_authority_expired",
} as const;

export function backfilledHoldReason(reason_code: string): string {
  return reason_code === AUTHORITY_HOLD_BACKFILL.from ? AUTHORITY_HOLD_BACKFILL.to : reason_code;
}
