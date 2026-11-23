import type { components } from "@cli-core/engine-api/openapi";
import type { TranslationKey } from "@/lib/i18n";

export type ScheduleOccurrence = components["schemas"]["ScheduleOccurrence"];

type Tone = "ok" | "info" | "warn" | "neutral";

const STATE_TONE: Record<ScheduleOccurrence["state"], Tone> = {
  ran: "ok",
  ran_late: "info",
  skipped: "neutral",
  held: "warn",
};

const STATE_KEYS: Record<ScheduleOccurrence["state"], TranslationKey> = {
  ran: "scheduleHistory.state.ran",
  ran_late: "scheduleHistory.state.ran_late",
  skipped: "scheduleHistory.state.skipped",
  held: "scheduleHistory.state.held",
};

const REASON_KEYS: Record<string, TranslationKey> = {
  late_start: "scheduleHistory.reason.late_start",
  merged_missed: "scheduleHistory.reason.merged_missed",
  calendar_weekend: "scheduleHistory.reason.calendar_weekend",
  calendar_skip_date: "scheduleHistory.reason.calendar_skip_date",
  failure_backoff: "scheduleHistory.reason.failure_backoff",
  repeated_failures: "scheduleHistory.reason.repeated_failures",
  input_required: "scheduleHistory.reason.input_required",
  execution_authority_required: "scheduleHistory.reason.execution_authority_required",
  execution_authority_expired: "scheduleHistory.reason.execution_authority_expired",
  execution_authority_exhausted: "scheduleHistory.reason.execution_authority_exhausted",
  execution_authority_revoked: "scheduleHistory.reason.execution_authority_revoked",
  execution_authority_changed: "scheduleHistory.reason.execution_authority_changed",
  grant_required: "scheduleHistory.reason.grant_required",
  grant_expired: "scheduleHistory.reason.grant_expired",
  previous_run_active: "scheduleHistory.reason.previous_run_active",
};

export function occurrenceTone(state: ScheduleOccurrence["state"]): Tone {
  return STATE_TONE[state];
}

export function occurrenceSentenceKey(
  occurrence: Pick<ScheduleOccurrence, "state" | "reason_code">,
): TranslationKey {
  const reason = occurrence.reason_code ? REASON_KEYS[occurrence.reason_code] : undefined;
  return reason ?? STATE_KEYS[occurrence.state];
}

export function occurrenceCovers(
  occurrence: Pick<ScheduleOccurrence, "state" | "skipped_count">,
): number {
  if (occurrence.state === "ran") return 0;
  if (occurrence.state === "ran_late") return occurrence.skipped_count;
  return occurrence.skipped_count > 1 ? occurrence.skipped_count : 0;
}

export interface OccurrenceDay<T> {
  day: string;
  items: T[];
}

export function groupOccurrencesByDay<T extends Pick<ScheduleOccurrence, "due_at">>(
  occurrences: readonly T[],
  dayOf: (instant: string) => string,
): OccurrenceDay<T>[] {
  const days: OccurrenceDay<T>[] = [];
  for (const occurrence of occurrences) {
    const day = dayOf(occurrence.due_at);
    const last = days[days.length - 1];
    if (last && last.day === day) last.items.push(occurrence);
    else days.push({ day, items: [occurrence] });
  }
  return days;
}

const APPROVAL_FAILURES = new Set([
  "authority_mismatch",
  "refused_before_start",
  "execution_authority_required",
  "execution_authority_expired",
  "execution_authority_exhausted",
  "execution_authority_revoked",
  "execution_authority_changed",
]);

export type AutoPauseRemedy = "renew_approval" | "resume";

export function autoPauseRemedy(pause: { failure_class: string }): AutoPauseRemedy {
  return APPROVAL_FAILURES.has(pause.failure_class) ? "renew_approval" : "resume";
}

export function autoPauseFacts(
  schedule: { id: string; cron: string },
  pause: { failure_class: string; since: string },
  when: (iso: string) => string,
): [TranslationKey, string][] {
  return [
    ["scheduleAutoPause.fact.schedule", schedule.id],
    ["scheduleAutoPause.fact.cron", schedule.cron],
    ["scheduleAutoPause.fact.cause", pause.failure_class],
    ["scheduleAutoPause.fact.since", when(pause.since)],
  ];
}
