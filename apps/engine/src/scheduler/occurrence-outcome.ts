export const OCCURRENCE_RUN_OUTCOMES = ["running", "succeeded", "failed", "aborted"] as const;
export type OccurrenceRunOutcome = (typeof OCCURRENCE_RUN_OUTCOMES)[number];

const EXECUTION_OUTCOME: Record<string, OccurrenceRunOutcome> = {
  queued: "running",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  timed_out: "failed",
  aborted: "aborted",
};

const TASK_RUN_OUTCOME: Record<string, OccurrenceRunOutcome> = {
  running: "running",
  waiting: "running",
  sleeping: "running",
  result_ready: "succeeded",
  completed: "succeeded",
  failed: "failed",
  aborted: "aborted",
};

export interface OccurrenceRunRef {
  id: string;
  execution_id: string | null;
  task_run_id: string | null;
}

export interface RunStates {
  executions: ReadonlyMap<string, string>;
  task_runs: ReadonlyMap<string, string>;
}

export function occurrenceRunOutcome(
  occurrence: Omit<OccurrenceRunRef, "id">,
  states: RunStates,
): OccurrenceRunOutcome | null {
  if (occurrence.execution_id) {
    const status = states.executions.get(occurrence.execution_id);
    return status ? (EXECUTION_OUTCOME[status] ?? null) : null;
  }
  if (occurrence.task_run_id) {
    const state = states.task_runs.get(occurrence.task_run_id);
    return state ? (TASK_RUN_OUTCOME[state] ?? null) : null;
  }
  return null;
}

export function occurrenceRunOutcomes(
  occurrences: readonly OccurrenceRunRef[],
  states: RunStates,
): Map<string, OccurrenceRunOutcome | null> {
  return new Map(occurrences.map((o) => [o.id, occurrenceRunOutcome(o, states)]));
}
