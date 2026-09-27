// When a schedule will really fire next — derived from the same decisions the
// reconciler makes, not from the cron expression alone.
//
//   * Cron schedules: the reconciler fires once `now` passes the first cron
//     occurrence after the last enqueue (or after creation, for a schedule that
//     never fired) — `nextCronOccurrence`, shared with `isCronDue`. An
//     occurrence already passed fires on the next reconcile tick, i.e. now.
//   * Calendar gates: a gated tick does NOT advance `last_enqueued_at`, so the
//     schedule stays due and fires on the first tick whose local day the gates
//     allow (`calendarGateSkipReason`, shared with the reconciler). A Friday
//     evening business-days schedule therefore next fires at local midnight
//     Monday, not on Saturday.
//   * `every:N` schedules run on a local interval timer that fires once the
//     last enqueue is N seconds old; the next fire is that moment, or — when it
//     has already passed — no later than one interval from now (the timer's
//     phase is per-process and not observable). The timer applies no gates.
//
// Null when the gates keep every day closed within GATE_SEARCH_DAYS (e.g. a
// long skip_dates freeze): the next fire exists but is too far to name
// honestly, and an unbounded search would run on every workflow list read.

import { calendarGateSkipReason, readCalendarGates } from "./calendar-gates.ts";
import { nextCronOccurrence, parseCronExpression } from "./cron.ts";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
export const GATE_SEARCH_DAYS = 60;

export interface NextFireSchedule {
  cron: string;
  timezone: string;
  input: unknown;
  last_enqueued_at: Date | null;
  created_at: Date;
}

/** First instant at or after `from` whose local day the gates allow, or null. */
function firstOpenInstant(
  from: Date,
  tz: string,
  gates: ReturnType<typeof readCalendarGates>,
): Date | null {
  if (calendarGateSkipReason(from, tz, gates) === null) return from;
  // Days change on local midnight, which is not on a UTC hour everywhere:
  // step by the hour to the first open hour, then by the minute inside it.
  const limit = from.getTime() + GATE_SEARCH_DAYS * 24 * HOUR_MS;
  let closed = from.getTime();
  let t = closed + HOUR_MS;
  while (t <= limit && calendarGateSkipReason(new Date(t), tz, gates) !== null) {
    closed = t;
    t += HOUR_MS;
  }
  if (t > limit) return null;
  for (let m = closed + MINUTE_MS; m < t; m += MINUTE_MS) {
    if (calendarGateSkipReason(new Date(m), tz, gates) === null) return new Date(m);
  }
  return new Date(t);
}

export function nextScheduleFire(schedule: NextFireSchedule, now: Date): string | null {
  const parsed = parseCronExpression(schedule.cron);
  if (!parsed.ok) return null;
  if (parsed.mode === "every") {
    const intervalMs = (parsed.everySeconds ?? 0) * 1000;
    const earliest = schedule.last_enqueued_at
      ? schedule.last_enqueued_at.getTime() + intervalMs
      : now.getTime() + intervalMs;
    return new Date(earliest > now.getTime() ? earliest : now.getTime() + intervalMs).toISOString();
  }
  const tz = schedule.timezone || "UTC";
  const baseline = schedule.last_enqueued_at ?? schedule.created_at;
  const occurrence = nextCronOccurrence(schedule.cron, baseline, tz);
  if (!occurrence) return null;
  const candidate = occurrence.getTime() > now.getTime() ? occurrence : now;
  const open = firstOpenInstant(candidate, tz, readCalendarGates(schedule.input));
  return open ? open.toISOString() : null;
}
