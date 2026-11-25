const ABORTABLE_EXECUTION_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "waiting_for_device",
  "running",
  "uncertain",
]);

export const isAbortableExecutionStatus = (status: string): boolean =>
  ABORTABLE_EXECUTION_STATUSES.has(status);

export const nothingToAbortLine = (execution: {
  id: string;
  status: string;
  finished_at?: string | null | undefined;
}): string => {
  const finished = execution.finished_at ? ` (finished ${execution.finished_at})` : "";
  return `execution ${execution.id} already ${execution.status}${finished} - nothing to abort`;
};

export const abortRequestedLine = (executionId: string): string =>
  `abort requested - execution ${executionId} is being aborted`;
