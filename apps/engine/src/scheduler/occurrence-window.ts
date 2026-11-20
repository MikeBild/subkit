import type { ScheduleOccurrenceState } from "../db/schema/index.ts";
import { nextCronOccurrence, previousCronOccurrence } from "./cron.ts";

export const OCCURRENCE_COUNT_CAP = 500;
export const OCCURRENCE_LATE_AFTER_MS = 5 * 60_000;
export const OCCURRENCE_RECORD_MIN_INTERVAL_MS = 60_000;

export interface DueWindow {
  first_due: Date;
  last_due: Date;
  count: number;
}

export function cronDueWindow(
  cron: string,
  tz: string,
  after: Date,
  now: Date,
  cap: number = OCCURRENCE_COUNT_CAP,
): DueWindow | null {
  const first_due = nextCronOccurrence(cron, after, tz);
  if (first_due === null || first_due.getTime() > now.getTime()) return null;
  let count = 1;
  let cursor = first_due;
  while (count < cap) {
    const next = nextCronOccurrence(cron, cursor, tz);
    if (next === null || next.getTime() > now.getTime() || next.getTime() <= cursor.getTime())
      break;
    cursor = next;
    count++;
  }
  const newest = count < cap ? cursor : previousCronOccurrence(cron, now, tz);
  const last_due = newest && newest.getTime() >= first_due.getTime() ? newest : cursor;
  return { first_due, last_due, count };
}

export function everyDueWindow(
  seconds: number,
  after: Date,
  now: Date,
  cap: number = OCCURRENCE_COUNT_CAP,
): DueWindow | null {
  const step = seconds * 1000;
  if (!Number.isFinite(step) || step <= 0) return null;
  const elapsed = now.getTime() - after.getTime();
  if (elapsed < step) return null;
  const total = Math.floor(elapsed / step);
  return {
    first_due: new Date(after.getTime() + step),
    last_due: new Date(after.getTime() + total * step),
    count: Math.min(total, cap),
  };
}

export function onceDueWindow(run_at: Date, after: Date | null, now: Date): DueWindow | null {
  if (run_at.getTime() > now.getTime()) return null;
  if (after !== null && after.getTime() >= run_at.getTime()) return null;
  return { first_due: run_at, last_due: run_at, count: 1 };
}

export interface RunClassification {
  state: Extract<ScheduleOccurrenceState, "ran" | "ran_late">;
  reason_code: "merged_missed" | "late_start" | null;
  skipped_count: number;
}

export function classifyRun(window: DueWindow, started_at: Date): RunClassification {
  if (window.count > 1)
    return { state: "ran_late", reason_code: "merged_missed", skipped_count: window.count - 1 };
  if (started_at.getTime() - window.last_due.getTime() > OCCURRENCE_LATE_AFTER_MS)
    return { state: "ran_late", reason_code: "late_start", skipped_count: 0 };
  return { state: "ran", reason_code: null, skipped_count: 0 };
}

export interface PriorOccurrence {
  state: ScheduleOccurrenceState;
  reason_code: string | null;
  last_due_at: Date;
}

export type OccurrenceWrite = { kind: "insert" } | { kind: "merge"; after: Date };

export function planOccurrenceWrite(
  prior: PriorOccurrence | null,
  next: { state: ScheduleOccurrenceState; reason_code: string | null },
): OccurrenceWrite {
  if (next.state === "ran" || next.state === "ran_late") return { kind: "insert" };
  if (prior && prior.state === next.state && prior.reason_code === next.reason_code)
    return { kind: "merge", after: prior.last_due_at };
  return { kind: "insert" };
}
