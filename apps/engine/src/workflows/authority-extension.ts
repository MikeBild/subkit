export const AUTHORITY_EXTEND_WITHIN_DAYS = 3;
export const AUTHORITY_EXTEND_BELOW_RUN_SHARE = 0.1;
export const AUTHORITY_EXPIRY_ATTENTION_DAYS = 7;
export const AUTHORITY_EXPIRY_NOTIFY_DAYS = AUTHORITY_EXTEND_WITHIN_DAYS;

const DAY_MS = 86_400_000;

export type ExpiryStage = "none" | "attention" | "notify" | "ended";

export function expiryStage(valid_until: Date | null, now: Date): ExpiryStage {
  if (valid_until === null) return "none";
  const left = valid_until.getTime() - now.getTime();
  if (left <= 0) return "ended";
  if (left <= AUTHORITY_EXPIRY_NOTIFY_DAYS * DAY_MS) return "notify";
  return left <= AUTHORITY_EXPIRY_ATTENTION_DAYS * DAY_MS ? "attention" : "none";
}
