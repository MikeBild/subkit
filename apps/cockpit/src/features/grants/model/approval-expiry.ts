const DAY_MS = 86_400_000;

export const APPROVAL_EXPIRY_STRIP_DAYS = 7;

const localDayNumber = (instant: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / DAY_MS;
};

export function approvalExpiryDays(
  validUntil: string | null | undefined,
  now: number,
  timeZone: string,
): number | null {
  if (!validUntil) return null;
  const end = Date.parse(validUntil);
  if (Number.isNaN(end) || end <= now) return null;
  const days = localDayNumber(end, timeZone) - localDayNumber(now, timeZone);
  return days <= APPROVAL_EXPIRY_STRIP_DAYS ? days : null;
}

export type ApprovalExpiryKey =
  | "approvalExpiry.today"
  | "approvalExpiry.tomorrow"
  | "approvalExpiry.days";

export function approvalExpiryKey(days: number): ApprovalExpiryKey {
  return days === 0
    ? "approvalExpiry.today"
    : days === 1
      ? "approvalExpiry.tomorrow"
      : "approvalExpiry.days";
}
