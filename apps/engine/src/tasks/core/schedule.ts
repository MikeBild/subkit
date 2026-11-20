import { nextCronOccurrence } from "../../scheduler/cron.ts";

export const TASK_SCHEDULE_MIN_INTERVAL_MS = 15 * 60_000;
const INTERVAL_SAMPLE = 120;
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

export function smallestCronGapMs(
  cron: string,
  timezone: string | null,
  from: Date,
): number | null {
  let previous = nextCronOccurrence(cron, from, timezone ?? UTC);
  let smallest: number | null = null;
  for (let index = 0; index < INTERVAL_SAMPLE && previous; index++) {
    const next = nextCronOccurrence(cron, previous, timezone ?? UTC);
    if (!next) break;
    const gap = next.getTime() - previous.getTime();
    if (smallest === null || gap < smallest) smallest = gap;
    previous = next;
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
  const gap = smallestCronGapMs(cron, schedule.schedule_timezone, now);
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
