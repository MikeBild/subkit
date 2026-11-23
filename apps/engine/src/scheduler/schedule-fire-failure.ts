import { isAuthorityRefusalCode } from "@shared/authority-refusal.ts";
import { errorFields, logger } from "../logging/index.ts";

export function isScheduleAdmissionHeldError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    (isAuthorityRefusalCode(error.code) || error.code === "input_required")
  );
}

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
  if (isScheduleAdmissionHeldError(error)) {
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
