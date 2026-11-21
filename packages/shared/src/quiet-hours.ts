export const DEFAULT_QUIET_HOURS = { start: "22:00", end: "07:00" } as const;

export const DEFAULT_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5];

export const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseClock(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = CLOCK_PATTERN.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
