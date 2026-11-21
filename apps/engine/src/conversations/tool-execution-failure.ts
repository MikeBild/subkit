import { isDatabaseQueryError } from "../logging/index.ts";

export const DATABASE_FAILURE_MESSAGE = "the lookup failed; check the arguments";

interface ToolExecutionFailure {
  database_failure: boolean;
  message: string;
  span_error: unknown;
  output: {
    ok: false;
    error: string;
    error_code: "tool_execution_failed";
    message: string;
    next_best_actions: string[];
  };
}

function causedByDatabaseQuery(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cause: unknown = error;
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause);
    if (isDatabaseQueryError(cause)) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

export function describeToolExecutionFailure(
  error: unknown,
  nextBestActions: string[] = [],
): ToolExecutionFailure {
  const databaseFailure = causedByDatabaseQuery(error);
  const message = databaseFailure
    ? DATABASE_FAILURE_MESSAGE
    : error instanceof Error
      ? error.message
      : String(error);
  return {
    database_failure: databaseFailure,
    message,
    span_error: databaseFailure ? new Error("database query failed") : error,
    output: {
      ok: false,
      error: message,
      error_code: "tool_execution_failed",
      message,
      next_best_actions: nextBestActions,
    },
  };
}
