import { logger } from "../../logging/logger.ts";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";
import { evaluate as evaluateJsonata } from "../jsonata-engine.ts";
import { deepResolveOffloadRefs } from "../offload-rehydrate.ts";
import { applyResponseFilters } from "../response-filter.ts";
import type { RunEnv, RunState } from "./env.ts";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function rehydrateOutput(env: RunEnv, state: RunState): Promise<void> {
  if (state.lastOutput === undefined || state.lastOutput === null) return;
  try {
    state.lastOutput = await deepResolveOffloadRefs(
      env.db,
      env.tenant_id,
      state.lastOutput,
      env.signal,
    );
  } catch (err) {
    logger.warn({
      module: "execution",
      action: "execution.offload_resolution_failed",
      msg: "final-output offload re-hydration failed",
      execution_id: env.execution_id,
      error: errorText(err),
    });
    state.finalStatus = "failed";
    state.validationError = {
      code: "offload_resolution_failed",
      message: errorText(err),
    };
  }
}

async function transformOutput(env: RunEnv, state: RunState): Promise<void> {
  const { def } = env;
  if (state.lastOutput === undefined || state.finalStatus !== "succeeded") return;
  const clock = {
    now_ms: env.execution_started_at,
    seed: `${env.evaluationSeed}:output_transform`,
  };
  if (def.output_transform) {
    try {
      const transformed = await evaluateJsonata(def.output_transform, state.lastOutput, {
        input: env.normalizedInput,
        scope: state.scope,
        clock,
      });
      if (transformed !== undefined) state.lastOutput = transformed;
    } catch (err) {
      logger.warn({
        module: "execution",
        action: "execution.output_transform_threw",
        msg: "output_transform threw",
        execution_id: env.execution_id,
        error: errorText(err),
      });
      state.finalStatus = "failed";
      state.validationError = {
        code: "output_transform_failed",
        message: `output_transform threw: ${errorText(err)}`,
        details: { expression: def.output_transform },
      };
    }
  } else if (def.output_transform_function) {
    try {
      const result = await runJs<unknown>({
        code: def.output_transform_function,
        input: state.lastOutput,
        clock,
      });
      if (result.output !== undefined) state.lastOutput = result.output;
    } catch (err) {
      logger.warn({
        module: "execution",
        action: "execution.output_transform_function_threw",
        msg: "output_transform_function threw",
        execution_id: env.execution_id,
        error: errorText(err),
      });
      state.finalStatus = "failed";
      state.validationError = {
        code: "output_transform_failed",
        message: `output_transform_function threw: ${errorText(err)}`,
        details: { expression: def.output_transform_function },
      };
    }
  }
}

function filterOutput(env: RunEnv, state: RunState): void {
  const filters = env.def.response_filters;
  if (
    !filters ||
    filters.length === 0 ||
    state.lastOutput === undefined ||
    state.finalStatus !== "succeeded"
  )
    return;
  try {
    state.lastOutput = applyResponseFilters(filters, state.lastOutput);
  } catch (err) {
    logger.warn({
      module: "execution",
      action: "execution.response_filter_failed",
      msg: "workflow-level response_filter raised — probably a FAIL filter matched",
      execution_id: env.execution_id,
      error: errorText(err),
    });
    state.finalStatus = "failed";
    state.validationError = {
      code: "response_filter_failed",
      message: `workflow-level response filter failed: ${errorText(err)}`,
    };
  }
}

export async function resolveFinalOutput(env: RunEnv, state: RunState): Promise<void> {
  await rehydrateOutput(env, state);
  await transformOutput(env, state);
  filterOutput(env, state);
}
