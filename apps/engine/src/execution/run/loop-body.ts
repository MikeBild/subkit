import { logger } from "../../logging/logger.ts";
import { recordLoopIterationsOffloaded } from "../../observability/instrumentation.ts";
import type { LoopStep, StepDef } from "../../workflows/types.ts";
import {
  continuedStepWarning,
  findHeldDependency,
  heldDependencyError,
  isFailedStepStatus,
  loopBodyEmptyWarning,
  stopsRunOnFailure,
  tallyIterations,
  withContainerFailure,
} from "../core/run.ts";
import {
  bodyEnvelopeForLoopAccumulator,
  classifyBodyIteration,
  envelopeFor,
  wrapEnvelope,
} from "../engine/envelope.ts";
import { buildLoopChildScope } from "../loop-scope.ts";
import { insertStepRow } from "../state.ts";
import type { RunStepOutcome } from "../step-runner.ts";
import { hasHeldOutput, type StepResult } from "../types.ts";
import {
  buildStepContext,
  type RunEnv,
  type RunPlan,
  type RunState,
  recordHeldChild,
  runInstrumentedStep,
  type StepFrame,
} from "./env.ts";

interface LoopBodyFailure {
  step_id: string;
  result: StepResult;
}

async function runLoopIteration(
  env: RunEnv,
  plan: RunPlan,
  state: RunState,
  frame: StepFrame,
  loopStep: LoopStep,
  item: unknown,
  itemIdx: number,
  failure: { current: LoopBodyFailure | null },
): Promise<Record<string, unknown>> {
  const childScope = buildLoopChildScope(state.scope, item, itemIdx);
  const bodyResults: Record<string, unknown> = {};
  const iterationHeldIds = new Set<string>();
  for (const bodyStepId of loopStep.body) {
    const bodyStep = env.def.steps.find((s) => s.id === bodyStepId) as StepDef | undefined;
    if (!bodyStep) continue;
    if (env.opts.hold_writes) {
      const heldDep = findHeldDependency(
        plan.dag,
        bodyStep.id,
        (sid) => iterationHeldIds.has(sid) || state.heldOrSkippedStepIds.has(sid),
      );
      if (heldDep) {
        iterationHeldIds.add(bodyStep.id);
        const skippedEnv = wrapEnvelope({
          data: null,
          duration_ms: 0,
          error: heldDependencyError(heldDep),
        });
        childScope[bodyStep.id] = skippedEnv;
        bodyResults[bodyStep.id] = skippedEnv;
        continue;
      }
    }
    const bodyStepRowId = await insertStepRow(env.db, {
      tenant_id: env.tenant_id,
      execution_id: env.execution_id,
      step_key: `${bodyStep.id}[${itemIdx}]`,
      step_index: frame.index,
      kind: bodyStep.kind,
    });
    const bodyCtx = buildStepContext(
      env,
      bodyStep,
      frame.index,
      bodyStepRowId,
      childScope,
      `${env.evaluationSeed}:loop:${loopStep.id}:${itemIdx}`,
    );
    const bodyOutcome = await runInstrumentedStep(env, bodyCtx, childScope, {
      step_id: bodyStep.id,
      step_kind: bodyStep.kind,
    });
    const bodyMeta = bodyOutcome.result.request_meta ?? null;
    if (bodyMeta && (bodyMeta.driver === "http" || bodyMeta.driver === "connectorless")) {
      logger.info({
        module: "execution",
        action: "loop.iteration",
        step_id: bodyStep.id,
        parent_step_id: loopStep.id,
        iteration: itemIdx,
        resolved_url: bodyMeta.url,
        upstream_status: bodyMeta.status ?? null,
        outcome: bodyOutcome.result.status,
      });
    }
    childScope[bodyStep.id] = envelopeFor(bodyOutcome);
    recordHeldChild(state, frame, `${bodyStep.id}[${itemIdx}]`, bodyCtx, bodyOutcome);
    bodyResults[bodyStep.id] = bodyEnvelopeForLoopAccumulator(bodyOutcome);
    if (hasHeldOutput(bodyOutcome.result)) {
      iterationHeldIds.add(bodyStep.id);
    }
    const bodyFailed = isFailedStepStatus(bodyOutcome.result.status);
    if (bodyFailed && stopsRunOnFailure(bodyStep)) {
      if (failure.current === null) {
        failure.current = { step_id: bodyStep.id, result: bodyOutcome.result };
      }
      if (loopStep.fail_fast === true) break;
    } else if (bodyFailed) {
      if (
        !state.warnings.some(
          (w) => w.code === "step_failed_continued" && w.step_key === bodyStep.id,
        )
      ) {
        state.warnings.push(
          continuedStepWarning(bodyStep.id, bodyOutcome.result.status, bodyOutcome.result.error),
        );
      }
    }
  }
  return bodyResults;
}

export async function runLoopBody(
  env: RunEnv,
  plan: RunPlan,
  state: RunState,
  frame: StepFrame,
  outcome: RunStepOutcome,
): Promise<RunStepOutcome> {
  const loopStep = frame.step as LoopStep;
  const items = outcome.result.output;
  if (!Array.isArray(items)) return outcome;
  const iterationResults: unknown[] = [];
  const failure: { current: LoopBodyFailure | null } = { current: null };
  for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
    iterationResults.push(
      await runLoopIteration(env, plan, state, frame, loopStep, items[itemIdx], itemIdx, failure),
    );
    if (loopStep.fail_fast === true && failure.current !== null) break;
  }
  state.scope[loopStep.id] = wrapEnvelope({
    data: iterationResults,
    duration_ms: outcome.result.duration_ms ?? 0,
    error: null,
  });
  if (frame.childHeld) state.heldOrSkippedStepIds.add(loopStep.id);
  state.lastOutput = iterationResults;
  if (iterationResults.length > 0) {
    const tally = tallyIterations(iterationResults, classifyBodyIteration);
    if (tally.offloaded > 0) {
      recordLoopIterationsOffloaded({ tenant_id: env.tenant_id, count: tally.offloaded });
    }
    if (tally.productive === 0) {
      state.warnings.push(loopBodyEmptyWarning(loopStep.id, iterationResults));
    }
  }
  const bodyFailure = failure.current;
  if (!bodyFailure) return outcome;
  return withContainerFailure(outcome, bodyFailure.result, {
    code: "loop_body_failed",
    message: `loop body step "${bodyFailure.step_id}" failed`,
  });
}
