import {
  type CronDayPlan,
  cronDayPlan,
  cronOccurrencesWithin,
  nextCronOccurrence,
  previousCronOccurrence,
} from "../../scheduler/cron.ts";

export const TASK_SCHEDULE_MIN_INTERVAL_MS = 15 * 60_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SCAN_DAYS = 28 * 366;
const LAST_INSTANT = 8_640_000_000_000_000;
const CLOCK_CHANGE_WINDOW_MS = 3 * 60 * MINUTE_MS;
const CLOCK_CHANGE_OCCURRENCE_CAP = 1_000;
const UTC = "UTC";

export interface TaskScheduleFields {
  schedule_cron: string | null;
  schedule_timezone: string | null;
  schedule_run_at: string | null;
}

export type TaskScheduleIssue =
  | "schedule_conflict"
  | "cron_interval_form"
  | "cron_invalid"
  | "cron_too_frequent"
  | "timezone_invalid"
  | "run_at_invalid"
  | "run_at_past";

function timezoneValid(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const smallestOf = (gaps: Array<number | null>): number | null =>
  gaps.reduce<number | null>(
    (smallest, gap) => (gap === null || (smallest !== null && smallest <= gap) ? smallest : gap),
    null,
  );

const consecutiveGaps = (instants: number[]): number[] =>
  instants.slice(1).map((instant, index) => instant - (instants[index] ?? instant));

function scanDays(from: Date): number[] {
  const firstDay = Math.floor(from.getTime() / DAY_MS) * DAY_MS - DAY_MS;
  const lastDay = Math.min(firstDay + SCAN_DAYS * DAY_MS, LAST_INSTANT - DAY_MS);
  return Array.from(
    { length: Math.max(0, Math.floor((lastDay - firstDay) / DAY_MS) + 1) },
    (_, index) => firstDay + index * DAY_MS,
  );
}

function dayBoundaryGapMs(plan: CronDayPlan, days: number[]): number | null {
  const firstStart = plan.startMinutes[0] ?? 0;
  const lastStart = plan.startMinutes.at(-1) ?? 0;
  const closest = (lastStart - firstStart) * MINUTE_MS;
  let previousDay: number | null = null;
  let smallest: number | null = null;
  for (const day of days) {
    if (!plan.firesOnDay(day)) continue;
    if (previousDay !== null) smallest = smallestOf([smallest, day - previousDay - closest]);
    if (smallest === DAY_MS - closest) return smallest;
    previousDay = day;
  }
  return smallest;
}

function utcOffsetMinutes(formatter: Intl.DateTimeFormat, instant: number): number {
  const part = Object.fromEntries(
    formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, Number(value)]),
  );
  const wallClock = Date.UTC(
    part.year ?? 0,
    (part.month ?? 1) - 1,
    part.day ?? 1,
    part.hour ?? 0,
    part.minute ?? 0,
  );
  return Math.round((wallClock - Math.floor(instant / MINUTE_MS) * MINUTE_MS) / MINUTE_MS);
}

function clockChangeAfter(formatter: Intl.DateTimeFormat, start: number, end: number): number {
  const offsetAtStart = utcOffsetMinutes(formatter, start);
  let [before, after] = [start, end];
  while (after - before > MINUTE_MS) {
    const middle = before + Math.floor((after - before) / 2);
    if (utcOffsetMinutes(formatter, middle) === offsetAtStart) before = middle;
    else after = middle;
  }
  return after;
}

function clockChanges(timezone: string, days: number[]): number[] {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  const offsets = days.map((day) => utcOffsetMinutes(formatter, day));
  return days.flatMap((day, index) =>
    index + 1 < days.length && offsets[index] !== offsets[index + 1]
      ? [clockChangeAfter(formatter, day, day + DAY_MS)]
      : [],
  );
}

function clockChangeGapMs(cron: string, timezone: string, clockChange: number): number | null {
  const windowStart = new Date(clockChange - CLOCK_CHANGE_WINDOW_MS);
  const before = previousCronOccurrence(cron, windowStart, timezone);
  const within = cronOccurrencesWithin(
    cron,
    windowStart,
    new Date(clockChange + CLOCK_CHANGE_WINDOW_MS),
    timezone,
    CLOCK_CHANGE_OCCURRENCE_CAP,
  );
  const last = within.at(-1) ?? before;
  const after = last ? nextCronOccurrence(cron, last, timezone) : null;
  const instants = [before, ...within, after].flatMap((instant) =>
    instant ? [instant.getTime()] : [],
  );
  return smallestOf(consecutiveGaps([...new Set(instants)]));
}

export function smallestCronGapMs(
  cron: string,
  timezone: string | null,
  from: Date,
  stopBelowMs = MINUTE_MS + 1,
): number | null {
  const zone = timezone ?? UTC;
  const first = nextCronOccurrence(cron, from, zone);
  const plan = cronDayPlan(cron);
  if (!first || !plan) return null;
  const days = scanDays(from);
  const candidates: Array<() => number | null> = [
    () => {
      const second = nextCronOccurrence(cron, first, zone);
      return second ? second.getTime() - first.getTime() : null;
    },
    () => smallestOf(consecutiveGaps(plan.startMinutes).map((gap) => gap * MINUTE_MS)),
    () => dayBoundaryGapMs(plan, days),
    ...(zone === UTC ? [] : clockChanges(zone, days)).map(
      (change) => () => clockChangeGapMs(cron, zone, change),
    ),
  ];
  let smallest: number | null = null;
  for (const candidate of candidates) {
    smallest = smallestOf([smallest, candidate()]);
    if (smallest !== null && smallest < stopBelowMs) return smallest;
  }
  return smallest;
}

export function taskScheduleIssue(
  schedule: TaskScheduleFields,
  now: Date,
): TaskScheduleIssue | null {
  if (schedule.schedule_cron !== null && schedule.schedule_run_at !== null)
    return "schedule_conflict";
  if (schedule.schedule_timezone !== null && !timezoneValid(schedule.schedule_timezone))
    return "timezone_invalid";
  if (schedule.schedule_run_at !== null) {
    const at = Date.parse(schedule.schedule_run_at);
    if (Number.isNaN(at)) return "run_at_invalid";
    if (at <= now.getTime()) return "run_at_past";
  }
  if (schedule.schedule_cron === null) return null;
  const cron = schedule.schedule_cron.trim();
  if (cron.startsWith("every:")) return "cron_interval_form";
  if (cron.split(/\s+/).length !== 5) return "cron_invalid";
  const gap = smallestCronGapMs(
    cron,
    schedule.schedule_timezone,
    now,
    TASK_SCHEDULE_MIN_INTERVAL_MS,
  );
  if (gap === null) return "cron_invalid";
  return gap < TASK_SCHEDULE_MIN_INTERVAL_MS ? "cron_too_frequent" : null;
}

export interface TaskScheduleClock {
  last_claimed_at: Date | null;
  anchor: Date;
}

export function nextTaskStart(schedule: TaskScheduleFields, clock: TaskScheduleClock): Date | null {
  if (schedule.schedule_run_at !== null)
    return clock.last_claimed_at === null ? new Date(schedule.schedule_run_at) : null;
  if (schedule.schedule_cron === null) return null;
  return nextCronOccurrence(
    schedule.schedule_cron,
    clock.last_claimed_at ?? clock.anchor,
    schedule.schedule_timezone ?? UTC,
  );
}

export interface TaskScheduleState {
  last_claimed_at: Date | null;
  schedule_anchor_at: Date;
  admission_hold_since: Date | null;
}

export function taskScheduleClock(task: TaskScheduleState): TaskScheduleClock {
  return {
    last_claimed_at: task.last_claimed_at,
    anchor: task.admission_hold_since
      ? new Date(task.admission_hold_since.getTime() - 1)
      : task.schedule_anchor_at,
  };
}

export function taskTriggerFor(schedule: TaskScheduleFields): "once" | "cron" | null {
  if (schedule.schedule_run_at !== null) return "once";
  return schedule.schedule_cron === null ? null : "cron";
}

export function isTaskDue(
  schedule: TaskScheduleFields,
  clock: TaskScheduleClock,
  now: Date,
): boolean {
  const next = nextTaskStart(schedule, clock);
  return next !== null && next <= now;
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}

export function taskScheduleChanged(prior: TaskScheduleFields, next: TaskScheduleFields): boolean {
  return (
    prior.schedule_cron !== next.schedule_cron ||
    prior.schedule_timezone !== next.schedule_timezone ||
    !sameInstant(prior.schedule_run_at, next.schedule_run_at)
  );
}
