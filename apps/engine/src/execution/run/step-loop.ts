import { logger } from "../../logging/index.ts";
import type { BranchStep, StepDef } from "../../workflows/types.ts";
import { budgetPause } from "../core/budget-pause.ts";
import {
  abortedStepSummary,
  branchArmStepIds,
  branchSkippedStepSummary,
  classifyStepEntry,
  findHeldDependency,
  fixtureStepSummary,
  heldSkippedStepSummary,
  outcomeStepSummary,
  untakenArmStepIds,
} from "../core/run.ts";
import { envelopeFor } from "../engine/envelope.ts";
import { previewOffloadRefs } from "../offload-rehydrate.ts";
import { insertStepRow } from "../state.ts";
import type { RunStepOutcome } from "../step-runner.ts";
import { hasHeldOutput } from "../types.ts";
import {
  buildStepContext,
  type RunEnv,
  type RunPlan,
  type RunState,
  runInstrumentedStep,
  type StepFrame,
  type StepVerdict,
  settleStepVerdict,
} from "./env.ts";
import { runForEachStep } from "./for-each.ts";
import { runParallelBranches } from "./parallel.ts";

function skipUntakenArm(state: RunState, branchStep: BranchStep, output: unknown): void {
  for (const skipId of untakenArmStepIds(branchStep, output)) state.skippedStepIds.add(skipId);
}

function enterStep(
  env: RunEnv,
  plan: RunPlan,
  state: RunState,
  step: StepDef,
  index: number,
): boolean {
  const entry = classifyStepEntry({
    aborted: env.signal.aborted,
    skipped: state.skippedStepIds.has(step.id),
    containerChild: plan.containerChildIds.has(step.id),
    fixture: env.opts.step_output_fixtures?.[step.id] ?? env.opts.budget_resume?.[step.id],
    heldDependency: env.opts.hold_writes
      ? findHeldDependency(plan.dag, step.id, (sid) => state.heldOrSkippedStepIds.has(sid))
      : null,
  });
  switch (entry.kind) {
    case "aborted":
      state.stepSummaries.push(abortedStepSummary(step, index));
      return false;
    case "skipped":
      if (step.kind === "branch" && state.skippedStepIds.has(step.id)) {
        for (const id of branchArmStepIds(step as BranchStep)) state.skippedStepIds.add(id);
      }
      state.stepSummaries.push(branchSkippedStepSummary(step, index));
      return false;
    case "fixture":
      state.scope[step.id] = entry.envelope;
      state.lastOutput = entry.data;
      if (step.kind === "branch") skipUntakenArm(state, step as BranchStep, entry.data);
      state.stepSummaries.push(fixtureStepSummary(step, index, entry.data));
      return false;
    case "held":
      state.heldOrSkippedStepIds.add(step.id);
      state.stepSummaries.push(heldSkippedStepSummary(step, index, entry.dependency));
      return false;
    case "run":
      return true;
  }
}

async function runTopLevelStep(env: RunEnv, frame: StepFrame, scope: Record<string, unknown>) {
  const { step } = frame;
  try {
    return await runInstrumentedStep(env, frame.ctx, scope, {
      step_id: step.id,
      step_kind: step.kind,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({
      module: "execution",
      action: "execution.step_crash",
      msg: "step driver threw",
      execution_id: env.execution_id,
      step_id: step.id,
      error: message,
    });
    const crashed: RunStepOutcome = {
      result: {
        status: "failed" as const,
        retry_count: 0,
        duration_ms: 0,
        error: { code: "step_crash", message },
      },
      scope_value: undefined,
    };
    return crashed;
  }
}

async function dispatchStep(
  env: RunEnv,
  plan: RunPlan,
  state: RunState,
  frame: StepFrame,
): Promise<StepVerdict> {
  const { step } = frame;
  let outcome = await runTopLevelStep(env, frame, state.scope);
  state.scope[step.id] = envelopeFor(outcome);
  state.lastOutput = outcome.scope_value;
  if (hasHeldOutput(outcome.result)) {
    state.heldOrSkippedStepIds.add(step.id);
  }
  if (outcome.result.warnings?.length) {
    for (const w of outcome.result.warnings) {
      state.warnings.push({ ...w, step_key: step.id });
    }
  }
  if (step.kind === "branch" && outcome.result.status === "succeeded") {
    skipUntakenArm(state, step as BranchStep, outcome.result.output);
  }
  if (step.kind === "parallel" && outcome.result.status === "succeeded") {
    outcome = await runParallelBranches(env, plan, state, frame, outcome);
  }
  let outputPreview: unknown = outcome.result.output;
  if (step.kind === "parallel") {
    const wrapped = state.scope[step.id] as { data?: unknown } | undefined;
    if (wrapped && typeof wrapped === "object" && "data" in wrapped) {
      outputPreview = previewOffloadRefs(wrapped.data);
    }
  }
  state.stepSummaries.push(
    outcomeStepSummary(step, frame.index, outcome.result, outputPreview, outcome.raw_output),
  );
  return { status: outcome.result.status, error: outcome.result.error };
}

export async function runStepLoop(env: RunEnv, plan: RunPlan, state: RunState): Promise<void> {
  const { executionOrder } = plan;
  for (let topoIdx = 0; topoIdx < executionOrder.length; topoIdx++) {
    const id = executionOrder[topoIdx] as string;
    const index = plan.stepIndexById.get(id) ?? topoIdx;
    const step = env.def.steps[index] as StepDef;
    if (!enterStep(env, plan, state, step, index)) continue;
    const step_row_id = await insertStepRow(env.db, {
      tenant_id: env.tenant_id,
      execution_id: env.execution_id,
      step_key: step.id,
      step_index: index,
      kind: step.kind,
    });
    const frame: StepFrame = {
      step,
      index,
      topoIndex: topoIdx,
      step_row_id,
      ctx: buildStepContext(env, step, index, step_row_id, state.scope, env.evaluationSeed),
      childHeld: false,
    };
    const verdict = step.for_each
      ? await runForEachStep(env, plan, state, frame, step.for_each)
      : await dispatchStep(env, plan, state, frame);
    const pause = budgetPause({
      error_code: verdict.error?.code,
      step_kind: step.kind,
      for_each: Boolean(step.for_each),
      authorized: env.ownConnectorCredentials,
      child: env.parent_execution_id !== null,
      held: env.opts.hold_writes === true,
      sensitive: env.execution_privacy === "sensitive",
      persisted: env.resolved.persist_workflow_refs,
    });
    if (pause === "park") {
      state.budgetPark = { step_id: step.id, step_row_id };
      break;
    }
    if (settleStepVerdict(env, plan, state, frame, verdict) === "stop") break;
  }
}
