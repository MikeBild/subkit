import { CronDate } from "cron-parser";
import { calendarGateSkipReason, readCalendarGates } from "./calendar-gates.ts";
import { nextCronOccurrence, parseCronExpression, previousCronOccurrence } from "./cron.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
export const GATE_SEARCH_DAYS = 60;

interface NextFireSchedule {
  cron: string;
  timezone: string;
  input: unknown;
  last_enqueued_at: Date | null;
  created_at: Date;
}

function firstOpenOccurrence(
  first: Date,
  cron: string,
  tz: string,
  gates: ReturnType<typeof readCalendarGates>,
  now: Date,
): Date | null {
  const limit = Math.max(first.getTime(), now.getTime()) + GATE_SEARCH_DAYS * DAY_MS;
  let occurrence: Date | null = first;
  while (occurrence && occurrence.getTime() <= limit) {
    if (calendarGateSkipReason(occurrence, tz, gates) === null) return occurrence;
    const nextDay = new CronDate(occurrence, tz);
    nextDay.addDay();
    occurrence = nextCronOccurrence(cron, new Date(nextDay.getTime() - 1), tz);
  }
  return null;
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
  const lastDue =
    occurrence.getTime() > now.getTime()
      ? occurrence
      : (previousCronOccurrence(schedule.cron, now, tz) ?? occurrence);
  const open = firstOpenOccurrence(
    lastDue,
    schedule.cron,
    tz,
    readCalendarGates(schedule.input),
    now,
  );
  if (!open) return null;
  return (open.getTime() > now.getTime() ? open : now).toISOString();
}
