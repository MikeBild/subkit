import { backoffDelay } from "@shared/backoff.ts";
import { classifyPersistedFailure } from "../execution/core/classify.ts";

export const FAILURE_BACKOFF_AFTER = 3;
export const FAILURE_PAUSE_AFTER = 5;
const FAILURE_BACKOFF_BASE_MINUTES = 2;
const FAILURE_BACKOFF_FACTOR = 3;
const FAILURE_BACKOFF_MAX_MINUTES = 54;
export const FAILURE_STREAK_WINDOW = FAILURE_PAUSE_AFTER;

const MINUTE_MS = 60_000;

export interface ScheduledRunOutcome {
  status: string;
  error_code: string | null;
  error_message: string | null;
  finished_at: Date;
}

export type FailureAssessment =
  | { action: "run"; streak: number; failure_class: string | null }
  | { action: "backoff"; streak: number; failure_class: string; retry_at: Date }
  | { action: "pause"; streak: number; failure_class: string };

export function failureClassOf(run: Pick<ScheduledRunOutcome, "status" | "error_code">): string {
  if (run.status === "timed_out") return "timed_out";
  const code = run.error_code?.trim() ?? "";
  return /^[a-z][a-z0-9_]{0,99}$/.test(code) ? code : "unclassified";
}

export function failureCauseOf(
  run: Pick<ScheduledRunOutcome, "status" | "error_code" | "error_message">,
): string {
  if (run.status === "timed_out") return "timeout";
  return classifyPersistedFailure({
    status: run.status,
    error: { code: run.error_code, message: run.error_message },
  }).classification;
}

function isFailure(run: Pick<ScheduledRunOutcome, "status">): boolean {
  return run.status === "failed" || run.status === "timed_out";
}

export function failureBackoffMs(streak: number): number {
  if (streak < FAILURE_BACKOFF_AFTER) return 0;
  return backoffDelay(streak - FAILURE_BACKOFF_AFTER, 0, {
    baseMs: FAILURE_BACKOFF_BASE_MINUTES * MINUTE_MS,
    factor: FAILURE_BACKOFF_FACTOR,
    maxMs: FAILURE_BACKOFF_MAX_MINUTES * MINUTE_MS,
    jitter: "none",
  });
}

export function failureStreak(newestFirst: readonly ScheduledRunOutcome[]): {
  streak: number;
  failure_class: string | null;
} {
  const lead = newestFirst[0];
  if (!lead || !isFailure(lead)) return { streak: 0, failure_class: null };
  const failure_class = failureClassOf(lead);
  const failure_cause = failureCauseOf(lead);
  let streak = 0;
  for (const run of newestFirst) {
    if (
      !isFailure(run) ||
      failureClassOf(run) !== failure_class ||
      failureCauseOf(run) !== failure_cause
    )
      break;
    streak++;
  }
  return { streak, failure_class };
}

export function assessFailures(
  newestFirst: readonly ScheduledRunOutcome[],
  now: Date,
): FailureAssessment {
  const { streak, failure_class } = failureStreak(newestFirst);
  const lead = newestFirst[0];
  if (!lead || failure_class === null || streak < FAILURE_BACKOFF_AFTER)
    return { action: "run", streak, failure_class };
  if (streak >= FAILURE_PAUSE_AFTER) return { action: "pause", streak, failure_class };
  const retry_at = new Date(lead.finished_at.getTime() + failureBackoffMs(streak));
  return retry_at.getTime() > now.getTime()
    ? { action: "backoff", streak, failure_class, retry_at }
    : { action: "run", streak, failure_class };
}
