import { instrument } from "../../observability/runtime-telemetry.ts";
import type { ParallelStep, StepDef } from "../../workflows/types.ts";
import {
  findHeldDependency,
  heldDependencyError,
  stopsRunOnFailure,
  withContainerFailure,
} from "../core/run.ts";
import { envelopeFor, wrapEnvelope } from "../engine/envelope.ts";
import { insertStepRow } from "../state.ts";
import type { RunStepOutcome } from "../step-runner.ts";
import { hasHeldOutput } from "../types.ts";
import {
  buildStepContext,
  type RunEnv,
  type RunPlan,
  type RunState,
  recordHeldChild,
  runInstrumentedStep,
  type StepFrame,
} from "./env.ts";

async function runParallelBranch(
  env: RunEnv,
  plan: RunPlan,
  state: RunState,
  frame: StepFrame,
  parallelStep: ParallelStep,
  branchStepIds: readonly string[],
  branchIndex: number,
  failure: { current: RunStepOutcome | null },
): Promise<Record<string, unknown>> {
  const branchScope: Record<string, unknown> = { ...state.scope };
  const branchOutput: Record<string, unknown> = {};
  const branchHeldIds = new Set<string>();
  for (const branchStepId of branchStepIds) {
    const branchStepDef = env.def.steps.find((s) => s.id === branchStepId) as StepDef | undefined;
    if (!branchStepDef) continue;
    if (env.opts.hold_writes) {
      const heldDep = findHeldDependency(
        plan.dag,
        branchStepDef.id,
        (sid) => branchHeldIds.has(sid) || state.heldOrSkippedStepIds.has(sid),
      );
      if (heldDep) {
        branchHeldIds.add(branchStepDef.id);
        const skippedEnv = wrapEnvelope({
          data: null,
          duration_ms: 0,
          error: heldDependencyError(heldDep),
        });
        branchScope[branchStepId] = skippedEnv;
        branchOutput[branchStepId] = skippedEnv;
        continue;
      }
    }
    const branchStepRowId = await insertStepRow(env.db, {
      tenant_id: env.tenant_id,
      execution_id: env.execution_id,
      step_key: branchStepId,
      step_index: frame.index,
      kind: branchStepDef.kind,
    });
    const branchCtx = buildStepContext(
      env,
      branchStepDef,
      frame.index,
      branchStepRowId,
      branchScope,
      `${env.evaluationSeed}:parallel:${parallelStep.id}:${branchIndex}`,
    );
    const branchOutcome = await runInstrumentedStep(env, branchCtx, branchScope, {
      step_id: branchStepDef.id,
      step_kind: branchStepDef.kind,
    });
    branchScope[branchStepId] = envelopeFor(branchOutcome);
    recordHeldChild(state, frame, branchStepId, branchCtx, branchOutcome);
    branchOutput[branchStepId] = envelopeFor(branchOutcome);
    if (hasHeldOutput(branchOutcome.result)) {
      branchHeldIds.add(branchStepId);
    }
    if (branchOutcome.result.status !== "succeeded" && stopsRunOnFailure(branchStepDef)) {
      failure.current ??= branchOutcome;
      break;
    }
  }
  return branchOutput;
}

export async function runParallelBranches(
  env: RunEnv,
  plan: RunPlan,
  state: RunState,
  frame: StepFrame,
  outcome: RunStepOutcome,
): Promise<RunStepOutcome> {
  const parallelStep = frame.step as ParallelStep;
  const failure: { current: RunStepOutcome | null } = { current: null };
  const branchResults = await instrument({
    module: "execution",
    action: "parallel",
    memory: true,
    fields: {
      step_id: parallelStep.id,
      branch_count: parallelStep.branches.length,
    },
    fn: () =>
      Promise.all(
        parallelStep.branches.map((branchStepIds, branchIndex) =>
          runParallelBranch(
            env,
            plan,
            state,
            frame,
            parallelStep,
            branchStepIds,
            branchIndex,
            failure,
          ),
        ),
      ),
  });
  state.scope[parallelStep.id] = wrapEnvelope({
    data: branchResults,
    duration_ms: outcome.result.duration_ms ?? 0,
    error: null,
  });
  state.lastOutput = branchResults;
  if (frame.childHeld) state.heldOrSkippedStepIds.add(parallelStep.id);
  if (!failure.current) return outcome;
  return withContainerFailure(outcome, failure.current.result, {
    code: "parallel_branch_failed",
    message: "a parallel branch failed",
  });
}
