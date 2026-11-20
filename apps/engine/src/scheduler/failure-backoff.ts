export const FAILURE_BACKOFF_AFTER = 3;
export const FAILURE_PAUSE_AFTER = 5;
export const FAILURE_BACKOFF_MINUTES = [2, 6, 18, 54] as const;
export const FAILURE_STREAK_WINDOW = FAILURE_PAUSE_AFTER;

const MINUTE_MS = 60_000;

export interface ScheduledRunOutcome {
  status: string;
  error_code: string | null;
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

function isFailure(run: Pick<ScheduledRunOutcome, "status">): boolean {
  return run.status === "failed" || run.status === "timed_out";
}

export function failureBackoffMs(streak: number): number {
  if (streak < FAILURE_BACKOFF_AFTER) return 0;
  const step = Math.min(streak - FAILURE_BACKOFF_AFTER, FAILURE_BACKOFF_MINUTES.length - 1);
  return (FAILURE_BACKOFF_MINUTES[step] ?? 0) * MINUTE_MS;
}

export function failureStreak(newestFirst: readonly ScheduledRunOutcome[]): {
  streak: number;
  failure_class: string | null;
} {
  const lead = newestFirst[0];
  if (!lead || !isFailure(lead)) return { streak: 0, failure_class: null };
  const failure_class = failureClassOf(lead);
  let streak = 0;
  for (const run of newestFirst) {
    if (!isFailure(run) || failureClassOf(run) !== failure_class) break;
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
