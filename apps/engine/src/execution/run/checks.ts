import { logger } from "../../logging/index.ts";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";
import { heldPreviewWarning } from "../core/run.ts";
import { evaluate as evaluateJsonata } from "../jsonata-engine.ts";
import { checkOutputContract, summarizeViolations } from "../output-contract.ts";
import type { OutputContractVerdict } from "../state.ts";
import type { SensitiveCheckVerdict } from "../types.ts";
import type { RunEnv, RunState } from "./env.ts";

export interface OutputChecks {
  outputContract: OutputContractVerdict;
  validationVerdict: SensitiveCheckVerdict;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function recordHeldPreview(env: RunEnv, state: RunState): boolean {
  const unavailable = env.opts.hold_writes === true && state.heldOrSkippedStepIds.size > 0;
  if (env.def.output_schema && unavailable && state.finalStatus === "succeeded") {
    logger.info({
      module: "execution",
      action: "execution.output_contract_skipped_held_preview",
      msg: "output_schema check skipped — hold-writes preview held the output-producing chain",
      execution_id: env.execution_id,
      held_or_skipped: state.heldOrSkippedStepIds.size,
    });
  }
  if (unavailable && state.finalStatus === "succeeded") {
    state.warnings.push(heldPreviewWarning(state.stepSummaries));
  }
  return unavailable;
}

function checkContract(env: RunEnv, state: RunState, unavailable: boolean): OutputContractVerdict {
  const schema = env.def.output_schema;
  if (!schema || state.lastOutput === undefined || state.finalStatus !== "succeeded" || unavailable)
    return "none";
  const contract = checkOutputContract(state.lastOutput, schema);
  if (!contract.ok) {
    logger.warn({
      module: "execution",
      action: "execution.output_schema_invalid",
      msg: "output_schema did not compile; contract check skipped",
      execution_id: env.execution_id,
      error: contract.schema_error,
    });
    return "none";
  }
  if (contract.valid) return "passed";
  logger.warn({
    module: "execution",
    action: "execution.output_contract_violation",
    msg: "final output does not satisfy output_schema",
    execution_id: env.execution_id,
    violations: contract.violations,
  });
  state.warnings.push({
    code: "output_contract_violation",
    message: `final output does not satisfy the workflow's output_schema (${contract.violations.length} violation(s)): ${summarizeViolations(contract.violations)}`,
    step_key: "$output",
    details: { violations: contract.violations },
  });
  return "violated";
}

async function runValidationExpression(
  env: RunEnv,
  state: RunState,
  verdict: SensitiveCheckVerdict,
): Promise<SensitiveCheckVerdict> {
  const expression = env.def.validation_expression;
  if (!expression || state.lastOutput === undefined || state.finalStatus !== "succeeded")
    return verdict;
  try {
    const value = await evaluateJsonata(expression, state.lastOutput, {
      input: env.normalizedInput,
      scope: state.scope,
      clock: { now_ms: env.execution_started_at, seed: `${env.evaluationSeed}:validation` },
    });
    if (!value) {
      logger.warn({
        module: "execution",
        action: "execution.validation_failed",
        msg: "validation_expression returned falsy",
        execution_id: env.execution_id,
        expression,
      });
      state.finalStatus = "failed";
      state.validationError = {
        code: "validation_failed",
        message: `validation_expression \`${expression}\` returned ${
          value === undefined ? "undefined" : JSON.stringify(value)
        }`,
        details: { expression, actual_value: state.lastOutput },
      };
      return "failed";
    }
    return "passed";
  } catch (err) {
    logger.warn({
      module: "execution",
      action: "execution.validation_threw",
      msg: "validation_expression threw",
      execution_id: env.execution_id,
      error: errorText(err),
    });
    state.finalStatus = "failed";
    state.validationError = {
      code: "validation_failed",
      message: `validation_expression \`${expression}\` threw: ${errorText(err)}`,
      details: { expression, actual_value: state.lastOutput },
    };
    return "failed";
  }
}

async function runValidationFunction(
  env: RunEnv,
  state: RunState,
  verdict: SensitiveCheckVerdict,
): Promise<SensitiveCheckVerdict> {
  const code = env.def.validation_function;
  if (!code || state.lastOutput === undefined || state.finalStatus !== "succeeded") return verdict;
  try {
    const result = await runJs<unknown>({
      code,
      input: state.lastOutput,
      clock: { now_ms: env.execution_started_at, seed: `${env.evaluationSeed}:validation` },
    });
    if (result.output === false) {
      logger.warn({
        module: "execution",
        action: "execution.validation_function_failed",
        msg: "validation_function returned false",
        execution_id: env.execution_id,
      });
      state.finalStatus = "failed";
      state.validationError = {
        code: "validation_failed",
        message: "validation_function returned false",
        details: { expression: code, actual_value: state.lastOutput },
      };
      return "failed";
    }
    return "passed";
  } catch (err) {
    logger.warn({
      module: "execution",
      action: "execution.validation_function_threw",
      msg: "validation_function threw",
      execution_id: env.execution_id,
      error: errorText(err),
    });
    state.finalStatus = "failed";
    state.validationError = {
      code: "validation_failed",
      message: `validation_function threw: ${errorText(err)}`,
      details: { expression: code, actual_value: state.lastOutput },
    };
    return "failed";
  }
}

export async function checkFinalOutput(env: RunEnv, state: RunState): Promise<OutputChecks> {
  const unavailable = recordHeldPreview(env, state);
  const outputContract = checkContract(env, state, unavailable);
  const initial: SensitiveCheckVerdict =
    env.def.validation_expression || env.def.validation_function ? "not_run" : "not_defined";
  const afterExpression = await runValidationExpression(env, state, initial);
  const validationVerdict = await runValidationFunction(env, state, afterExpression);
  return { outputContract, validationVerdict };
}
