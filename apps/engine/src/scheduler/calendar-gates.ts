// Calendar gates on a workflow schedule: `business_days_only` and
// `skip_dates`, evaluated in the schedule's timezone. Pure — shared by the
// reconciler (whether to fire now) and the published next fire time.

/**
 * Compute the calendar date in a target timezone for a real instant.
 * Returns `YYYY-MM-DD` so the reconciler can match against the
 * `skip_dates` array authored on the trigger.
 *
 * Implementation uses `Intl.DateTimeFormat` because Node's stdlib
 * `Date` only carries UTC + system-local zones. Invalid `tz` falls
 * back to UTC so a typo never crashes the reconciler — the schedule
 * still fires, just in the wrong zone. The cron-parser path validates
 * the same `tz` and surfaces the typo through the schedule fan-out.
 */
export function localDateInTz(now: Date, tz: string): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    // en-CA emits YYYY-MM-DD natively, so no part shuffling required.
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

/**
 * Compute the local-tz weekday (0=Sun..6=Sat) for a real instant. Used
 * by the `business_days_only` gate so weekends in the schedule's
 * timezone — not the engine's host zone — are recognised.
 */
export function localWeekdayInTz(now: Date, tz: string): number {
  try {
    // `weekday: short` is locale-stable and easy to map. The English
    // long form would also work but the short form is faster to scan.
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

/**
 * Calendar-gate decision used by the workflow-schedule fan-out. Encodes
 * the calendar-gate contract:
 *   - `business_days_only: true` skips Sat (6) + Sun (0) in `tz`.
 *   - `skip_dates` (YYYY-MM-DD) skips the explicit list in `tz`.
 *
 * Returns the reason string when the firing should be skipped, `null`
 * when it should proceed. The caller logs the reason via the
 * `schedule.skipped` action and leaves `last_enqueued_at` untouched so
 * the next cron tick gets a fresh evaluation.
 */
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

/**
 * The reverse-bind helper (`bindFromWorkflow`) stashes the calendar
 * gates inside the schedule's `input` jsonb so we don't need a schema
 * migration for two boolean knobs. The reconciler peels them off
 * before passing the row's `input` down to the execution as the
 * workflow's request payload — otherwise the workflow would observe
 * `business_days_only` / `skip_dates` keys that aren't part of its
 * input contract.
 */
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

/**
 * Strip the calendar-gate keys back out of the `input` jsonb before
 * the value flows to the execution as the workflow's request payload.
 * Schedules created via the legacy CRUD API (no trigger reverse-bind)
 * pass through unchanged because the gates simply aren't present.
 */
export function stripCalendarGates(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input ?? null;
  const obj = input as Record<string, unknown>;
  if (!("business_days_only" in obj) && !("skip_dates" in obj)) return input;
  const { business_days_only: _bd, skip_dates: _sd, ...rest } = obj;
  return Object.keys(rest).length === 0 ? null : rest;
}
