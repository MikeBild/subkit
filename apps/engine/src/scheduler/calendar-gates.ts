export function localDateInTz(now: Date, tz: string): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(now);
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  }
}

export function localWeekdayInTz(now: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
    });
    const day = fmt.format(now);
    const map: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    return map[day] ?? now.getUTCDay();
  } catch {
    return now.getUTCDay();
  }
}

export function calendarGateSkipReason(
  now: Date,
  tz: string,
  gates: { business_days_only?: boolean; skip_dates?: string[] },
): "weekend" | "skip_date" | null {
  if (gates.business_days_only === true) {
    const weekday = localWeekdayInTz(now, tz);
    if (weekday === 0 || weekday === 6) return "weekend";
  }
  if (gates.skip_dates && gates.skip_dates.length > 0) {
    const localDate = localDateInTz(now, tz);
    if (gates.skip_dates.includes(localDate)) return "skip_date";
  }
  return null;
}

export function readCalendarGates(input: unknown): {
  business_days_only?: boolean;
  skip_dates?: string[];
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const obj = input as Record<string, unknown>;
  const out: { business_days_only?: boolean; skip_dates?: string[] } = {};
  if (typeof obj.business_days_only === "boolean") {
    out.business_days_only = obj.business_days_only;
  }
  if (Array.isArray(obj.skip_dates)) {
    out.skip_dates = obj.skip_dates.filter((d): d is string => typeof d === "string");
  }
  return out;
}

export function stripCalendarGates(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input ?? null;
  const obj = input as Record<string, unknown>;
  if (!("business_days_only" in obj) && !("skip_dates" in obj)) return input;
  const { business_days_only: _bd, skip_dates: _sd, ...rest } = obj;
  return Object.keys(rest).length === 0 ? null : rest;
}
