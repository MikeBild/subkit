export type PushSchedule =
  | { readonly mode: "immediately" }
  | {
      readonly mode: "working_hours";
      readonly from: string;
      readonly to: string;
      readonly days?: readonly number[] | undefined;
    }
  | { readonly mode: "daily_digest"; readonly at: string };

export const DEFAULT_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5];

export function workingDays(days: readonly number[] | undefined): ReadonlySet<number> {
  const valid = (days ?? DEFAULT_WORKING_DAYS).filter(
    (day) => Number.isInteger(day) && day >= 1 && day <= 7,
  );
  return new Set(valid.length > 0 ? valid : DEFAULT_WORKING_DAYS);
}

export interface PushWindowInput {
  readonly schedule: PushSchedule;
  readonly timezone: string;
  readonly now: Date;
  readonly last_digest_at: Date | null;
}

export type PushDecision =
  | { readonly deliver: "all"; readonly digest: boolean }
  | { readonly deliver: "held"; readonly next_delivery: Date };

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

interface LocalDateTime extends LocalDate {
  readonly hour: number;
  readonly minute: number;
}

const MINUTE = 60_000;

export function safeTimeZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}

export function localDateTime(instant: Date, timezone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
  };
}

export function clockMinutes(clock: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(clock);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

function wallClock(local: LocalDateTime): number {
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
}

function offsetAt(instant: number, timezone: string): number {
  return wallClock(localDateTime(new Date(instant), timezone)) - instant;
}

export function zonedInstant(date: LocalDate, minutes: number, timezone: string): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day, 0, minutes);
  const candidates = [wall - offsetAt(wall - 12 * 60 * MINUTE, timezone)];
  const later = wall - offsetAt(wall + 12 * 60 * MINUTE, timezone);
  if (later !== candidates[0]) candidates.push(later);
  const exact = candidates
    .filter((candidate) => candidate + offsetAt(candidate, timezone) === wall)
    .sort((a, b) => a - b);
  return new Date(exact[0] ?? Math.max(...candidates));
}

function shiftDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  };
}

export function lastOccurrence(clock: string, now: Date, timezone: string): Date {
  const today = localDateTime(now, timezone);
  const minutes = clockMinutes(clock);
  for (const days of [1, 0, -1, -2]) {
    const candidate = zonedInstant(shiftDays(today, days), minutes, timezone);
    if (candidate.getTime() <= now.getTime()) return candidate;
  }
  return zonedInstant(shiftDays(today, -2), minutes, timezone);
}

export function nextOccurrence(clock: string, now: Date, timezone: string): Date {
  const today = localDateTime(now, timezone);
  const minutes = clockMinutes(clock);
  for (const days of [-1, 0, 1, 2]) {
    const candidate = zonedInstant(shiftDays(today, days), minutes, timezone);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return zonedInstant(shiftDays(today, 2), minutes, timezone);
}

export function isoWeekday(date: LocalDate): number {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

export interface WorkingWindow {
  readonly from: string;
  readonly to: string;
  readonly days?: readonly number[] | undefined;
}

function windowOf(
  window: WorkingWindow,
  date: LocalDate,
  timezone: string,
): { start: Date; end: Date } | null {
  if (!workingDays(window.days).has(isoWeekday(date))) return null;
  const from = clockMinutes(window.from);
  const to = clockMinutes(window.to);
  const start = zonedInstant(date, from, timezone);
  const end =
    from < to ? zonedInstant(date, to, timezone) : zonedInstant(shiftDays(date, 1), to, timezone);
  return { start, end };
}

const WEEK_LOOKAHEAD_DAYS = 8;

export function withinWorkingHours(window: WorkingWindow, now: Date, timezone: string): boolean {
  const today = localDateTime(now, timezone);
  for (const days of [-1, 0]) {
    const open = windowOf(window, shiftDays(today, days), timezone);
    if (open && open.start.getTime() <= now.getTime() && now.getTime() < open.end.getTime())
      return true;
  }
  return false;
}

export function currentWorkingStart(
  window: WorkingWindow,
  now: Date,
  timezone: string,
): Date | null {
  const today = localDateTime(now, timezone);
  for (const days of [0, -1]) {
    const open = windowOf(window, shiftDays(today, days), timezone);
    if (open && open.start.getTime() <= now.getTime() && now.getTime() < open.end.getTime())
      return open.start;
  }
  return null;
}

export function nextWorkingStart(window: WorkingWindow, now: Date, timezone: string): Date {
  const today = localDateTime(now, timezone);
  for (let days = 0; days <= WEEK_LOOKAHEAD_DAYS; days++) {
    const open = windowOf(window, shiftDays(today, days), timezone);
    if (open && open.start.getTime() > now.getTime()) return open.start;
  }
  return nextOccurrence(window.from, now, timezone);
}

export function decidePush(input: PushWindowInput): PushDecision {
  const { schedule, now } = input;
  const timezone = safeTimeZone(input.timezone);
  if (schedule.mode === "immediately") return { deliver: "all", digest: false };
  if (schedule.mode === "working_hours") {
    return withinWorkingHours(schedule, now, timezone)
      ? { deliver: "all", digest: false }
      : { deliver: "held", next_delivery: nextWorkingStart(schedule, now, timezone) };
  }
  const boundary = lastOccurrence(schedule.at, now, timezone);
  const due = input.last_digest_at === null || input.last_digest_at.getTime() < boundary.getTime();
  return due
    ? { deliver: "all", digest: true }
    : { deliver: "held", next_delivery: nextOccurrence(schedule.at, now, timezone) };
}

export const CRITICAL_SECURITY_REASONS: ReadonlySet<string> = new Set(["secret_unreadable"]);

export interface CriticalCandidate {
  readonly class: string;
  readonly reason: string;
  readonly subject: {
    readonly kind: string;
    readonly environment?: "dev" | "prod" | undefined;
  } | null;
  readonly approval?: { readonly environment: "dev" | "prod" } | undefined;
}

export function criticalEnvironment(item: CriticalCandidate): "dev" | "prod" | null {
  return item.subject?.environment ?? item.approval?.environment ?? null;
}

export function isCriticalPush(item: CriticalCandidate): boolean {
  if (CRITICAL_SECURITY_REASONS.has(item.reason)) return true;
  return item.class === "stopped" && criticalEnvironment(item) === "prod";
}
