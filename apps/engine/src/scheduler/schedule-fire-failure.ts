import { errorFields, logger } from "../logging/logger.ts";

export function logScheduleFireFailure(
  error: unknown,
  context: {
    tenant_id: string;
    workflow_id: string;
    schedule_id: string;
    schedule_key?: string;
  },
  action: "schedule.fanout_failed" | "schedule.fire_failed",
): void {
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "execution_authority_required" ||
      error.code === "execution_authority_unavailable" ||
      error.code === "input_required")
  ) {
    logger.warn({
      module: "scheduler",
      action: "schedule.admission_held",
      msg: "scheduled execution remains held until its effects have human approval",
      ...context,
      reason_code: error.code,
      reason: error.message,
    });
    return;
  }
  logger.error({
    module: "scheduler",
    action,
    msg: "workflow schedule enqueue failed",
    ...context,
    ...errorFields(error),
  });
}
