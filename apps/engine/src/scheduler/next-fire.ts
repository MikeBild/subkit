import { calendarGateSkipReason, readCalendarGates } from "./calendar-gates.ts";
import { nextCronOccurrence, parseCronExpression } from "./cron.ts";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
export const GATE_SEARCH_DAYS = 60;

interface NextFireSchedule {
  cron: string;
  timezone: string;
  input: unknown;
  last_enqueued_at: Date | null;
  created_at: Date;
}

function firstOpenInstant(
  from: Date,
  tz: string,
  gates: ReturnType<typeof readCalendarGates>,
): Date | null {
  if (calendarGateSkipReason(from, tz, gates) === null) return from;
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
