import { errorFields, logger } from "../logging/logger.ts";
import {
  boundedLabel,
  TASK_ADMISSION_REASON_LABELS,
  TASK_RUN_OUTCOME_LABELS,
  TASK_RUN_TRIGGER_LABELS,
  TASK_SWEEP_CLAIM_RESULT_LABELS,
  type TaskRunOutcome,
  type TaskSweepClaimResult,
} from "./metric-label-allowlists.ts";
import { getMetrics, METRIC_NAMES } from "./metrics.ts";

export type { TaskRunOutcome, TaskSweepClaimResult };

function safe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logger.warn({
      module: "observability",
      action: "metrics.write_failed",
      msg: "task metric write threw — ignoring",
      ...errorFields(err),
    });
  }
}

export function recordTaskRunOutcome(args: {
  tenant_id: string;
  outcome: TaskRunOutcome;
  trigger: string;
  duration_ms?: number | null | undefined;
}): void {
  safe(() => {
    const reg = getMetrics();
    const outcome = boundedLabel(TASK_RUN_OUTCOME_LABELS, args.outcome);
    reg.inc(METRIC_NAMES.TASK_RUN_TOTAL, {
      tenant_id: args.tenant_id,
      outcome,
      trigger: boundedLabel(TASK_RUN_TRIGGER_LABELS, args.trigger),
    });
    if (
      outcome !== "started" &&
      typeof args.duration_ms === "number" &&
      Number.isFinite(args.duration_ms) &&
      args.duration_ms >= 0
    ) {
      reg.observe(METRIC_NAMES.TASK_RUN_DURATION_MS, args.duration_ms, {
        tenant_id: args.tenant_id,
        outcome,
      });
    }
  });
}

export function recordTaskSweepClaim(args: { result: TaskSweepClaimResult }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.TASK_SWEEP_CLAIM_TOTAL, {
      result: boundedLabel(TASK_SWEEP_CLAIM_RESULT_LABELS, args.result),
    });
  });
}

export function recordTaskAdmission(args: { reason: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.TASK_ADMISSION_TOTAL, {
      reason: boundedLabel(TASK_ADMISSION_REASON_LABELS, args.reason),
    });
  });
}
