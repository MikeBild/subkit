// Per-step orchestration: applies the configured data_selector to the
// raw step result, applies offload, persists the step row, and emits the
// debug log. Drivers (request, transform, ...) own the actual work and
// the retry loops; this file owns the surrounding ceremony.

import { log, logger } from "../logging/logger.ts";
import type { StepDef } from "../workflows/types.ts";
import { maybeOffload, previewOf } from "./offload.ts";
import { applySelector } from "./selectors.ts";
import { finalizeStepRow } from "./state.ts";
import { runBranchStep } from "./steps/branch.ts";
import { runLoopStep } from "./steps/loop.ts";
import { runParallelStep } from "./steps/parallel.ts";
import { runRequestStep } from "./steps/request.ts";
import { runToolStep } from "./steps/tool.ts";
import { runTransformStep } from "./steps/transform.ts";
import { runWaitStep } from "./steps/wait.ts";
import type { StepResult, StepRunContext } from "./types.ts";

export interface RunStepOutcome {
  result: StepResult;
  // The value to expose to downstream steps (after data_selector projection).
  scope_value: unknown;
}

export async function runStep(
  ctx: StepRunContext,
  scope: Record<string, unknown>,
  workflowInput: unknown,
  callRunner: (sub: { ctx: StepRunContext; step: StepDef }) => Promise<StepResult>,
): Promise<RunStepOutcome> {
  const step = ctx.step;
  let result: StepResult;
  switch (step.kind) {
    case "request":
      result = await runRequestStep({ ctx, step, scope });
      break;
    case "transform":
      result = await runTransformStep({ ctx, step, scope, input: workflowInput });
      break;
    case "wait":
      result = await runWaitStep({ ctx, step });
      break;
    case "branch":
      result = await runBranchStep({ ctx, step, scope });
      break;
    case "parallel":
      result = await runParallelStep({ ctx, step });
      break;
    case "loop":
      result = await runLoopStep({ ctx, step, scope });
      break;
    case "call":
      result = await callRunner({ ctx, step });
      break;
    case "tool":
      result = await runToolStep({ ctx, step });
      break;
    default: {
      const _exhaustive: never = step;
      void _exhaustive;
      result = {
        status: "failed",
        retry_count: 0,
        duration_ms: 0,
        error: { code: "unknown_step_kind", message: "unknown step kind" },
      };
    }
  }

  if (result.status === "succeeded") {
    log.execution.step.completed({
      step_id: step.id,
      kind: step.kind,
      duration_ms: result.duration_ms,
      execution_id: ctx.execution_id,
    });
  } else if (result.status === "failed") {
    log.execution.step.failed({
      step_id: step.id,
      kind: step.kind,
      duration_ms: result.duration_ms,
      error_code: result.error?.code,
      error_msg: result.error?.message,
      execution_id: ctx.execution_id,
    });
  } else if (result.status === "timed_out") {
    log.execution.step.timeout({
      step_id: step.id,
      kind: step.kind,
      duration_ms: result.duration_ms,
      error_code: result.error?.code,
      execution_id: ctx.execution_id,
    });
  }

  let scope_value = result.output;
  if (result.status === "succeeded" && step.data_selector) {
    try {
      scope_value = applySelector(step.data_selector, result.output);
    } catch (err) {
      result = {
        ...result,
        status: "failed",
        error: {
          code: "data_selector_error",
          message: err instanceof Error ? err.message : String(err),
        },
      };
      scope_value = undefined;
    }
  }

  // Offload + preview
  const offload = await maybeOffload(ctx.db, {
    tenant_id: ctx.tenant_id,
    execution_id: ctx.execution_id,
    step_id: ctx.step_row_id,
    result: scope_value ?? result.output ?? null,
  });

  await finalizeStepRow(ctx.db, ctx.step_row_id, result.status, result, {
    output_preview: offload.storage_uri ? null : (scope_value ?? null),
    result_preview: offload.preview ?? previewOf(scope_value ?? null),
    result_storage_uri: offload.storage_uri,
  });

  logger.debug({
    module: "execution",
    action: "execution.step",
    msg: `step ${step.id} ${result.status}`,
    execution_id: ctx.execution_id,
    step_index: ctx.step_index,
    kind: step.kind,
    status: result.status,
    duration_ms: result.duration_ms,
    retry_count: result.retry_count,
    bytes_out: offload.size_bytes,
  });

  return { result, scope_value };
}
