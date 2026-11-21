import type { components } from "@cli-core/engine-api/openapi";

type ApiOccurrence = components["schemas"]["ScheduleOccurrence"];

export type OccState = "ran" | "late" | "skipped" | "held";
export type RunOutcome = "running" | "succeeded" | "failed" | "aborted";
export type OccTone = "success" | "warning" | "danger" | "neutral" | "info";

export interface Occurrence {
  id: string;
  ref: string;
  state: OccState;
  due: string;
  start: string | null;
  reasonCode: string | null;
  covers: number;
  runId: string | null;
  outcome: RunOutcome | null;
}

const OCC_STATE: Record<ApiOccurrence["state"], OccState> = {
  ran: "ran",
  ran_late: "late",
  skipped: "skipped",
  held: "held",
};

export function toOccurrence(
  occurrence: Pick<
    ApiOccurrence,
    | "id"
    | "workflow_id"
    | "task_id"
    | "state"
    | "due_at"
    | "started_at"
    | "reason_code"
    | "skipped_count"
    | "execution_id"
  > & { run_outcome?: RunOutcome | null; task_run_id?: string | null },
): Occurrence {
  const covers =
    occurrence.state === "ran"
      ? 0
      : occurrence.state === "ran_late" || occurrence.skipped_count > 1
        ? occurrence.skipped_count
        : 0;
  return {
    id: occurrence.id,
    ref: occurrence.workflow_id ?? occurrence.task_id ?? "",
    state: OCC_STATE[occurrence.state],
    due: occurrence.due_at,
    start: occurrence.started_at,
    reasonCode: occurrence.reason_code,
    covers,
    runId: occurrence.execution_id ?? occurrence.task_run_id ?? null,
    outcome: occurrence.run_outcome ?? null,
  };
}

export function sortOccurrences(items: readonly Occurrence[]): Occurrence[] {
  return [...items].sort((a, b) => b.due.localeCompare(a.due));
}

const STATE_TONE: Record<OccState, OccTone> = {
  ran: "success",
  late: "warning",
  skipped: "neutral",
  held: "warning",
};

export function occurrenceTone(occurrence: Pick<Occurrence, "state" | "outcome">): OccTone {
  if (occurrence.outcome === "failed") return "danger";
  if (occurrence.outcome === "running") return "info";
  if (occurrence.outcome === "aborted") return "neutral";
  return STATE_TONE[occurrence.state];
}

export type OccLabel = OccState | "failed" | "running" | "aborted";

export function occurrenceLabel(occurrence: Pick<Occurrence, "state" | "outcome">): OccLabel {
  if (occurrence.state !== "ran" && occurrence.state !== "late") return occurrence.state;
  if (
    occurrence.outcome === "failed" ||
    occurrence.outcome === "running" ||
    occurrence.outcome === "aborted"
  )
    return occurrence.outcome;
  return occurrence.state;
}
