import { getConnectorForEnvironment, isCircuitOpenBlocking } from "../../connectors/service.ts";
import { logger } from "../../logging/logger.ts";
import {
  recordForEachExecution,
  recordLoopIterationsOffloaded,
} from "../../observability/instrumentation.ts";
import type { RequestStep, StepDef } from "../../workflows/types.ts";
import { connectorStepRefusal } from "../connector-availability.ts";
import {
  failedContainerStepSummary,
  findHeldDependency,
  forEachBodyEmptyWarning,
  forEachVerdict,
  heldDependencyError,
  isFailedStepStatus,
  tallyIterations,
} from "../core/run.ts";
import {
  bodyEnvelopeForLoopAccumulator,
  classifyBodyIteration,
  envelopeFor,
  wrapEnvelope,
} from "../engine/envelope.ts";
import { buildLoopChildScope, resolveForEachCollection } from "../loop-scope.ts";
import { previewOffloadRefs } from "../offload-rehydrate.ts";
import { finalizeStepRow, insertStepRow } from "../state.ts";
import type { RunStepOutcome } from "../step-runner.ts";
import { classifyRequestStepSideEffects } from "../steps/request/side-effects.ts";
import type { StepResult, StepRunContext } from "../types.ts";
import {
  type RunEnv,
  type RunPlan,
  type RunState,
  recordHeldChild,
  runInstrumentedStep,
  type StepFrame,
  type StepVerdict,
} from "./env.ts";

const DEFAULT_FOR_EACH_CONCURRENCY = 8;

export function resolveForEachConcurrency(
  step: StepDef,
  itemCount: number,
  baseUrl?: string | null,
): number {
  if (itemCount <= 1) return 1;
  const explicit = (step as { for_each_concurrency?: number }).for_each_concurrency;
  if (explicit != null && explicit >= 1) return Math.min(explicit, itemCount);
  if (
    step.kind === "request" &&
    classifyRequestStepSideEffects(step as RequestStep, undefined, undefined, baseUrl) === "read"
  ) {
    return Math.min(itemCount, DEFAULT_FOR_EACH_CONCURRENCY);
  }
  return 1;
}

interface FanOutPreflight {
  failure: StepResult | null;
  baseUrl: string | null;
}

async function preflightFanOut(
  env: RunEnv,
  step: StepDef,
  itemCount: number,
  forEachStart: number,
): Promise<FanOutPreflight> {
  if (step.kind !== "request" || !step.connector_id) return { failure: null, baseUrl: null };
  const { clock, execution_mode } = env;
  const target = await getConnectorForEnvironment(
    env.tenant_id,
    step.connector_id,
    execution_mode,
    env.db,
  );
  const baseUrl = target?.base_url ?? null;
  const refusal = target ? connectorStepRefusal(target, step, execution_mode) : null;
  if (refusal) {
    return {
      baseUrl,
      failure: {
        status: "failed",
        retry_count: 0,
        duration_ms: clock.now() - forEachStart,
        error: refusal,
      },
    };
  }
  if (target && isCircuitOpenBlocking(target)) {
    logger.warn({
      module: "execution",
      action: "for_each.circuit_open_preflight",
      msg: "for_each target connector circuit breaker is open — failing the container without scheduling iterations",
      tenant_id: env.tenant_id,
      execution_id: env.execution_id,
      step_id: step.id,
      connector_id: target.id,
      connector_slug: target.slug,
      iterations_not_scheduled: itemCount,
    });
    return {
      baseUrl,
      failure: {
        status: "failed",
        retry_count: 0,
        duration_ms: clock.now() - forEachStart,
        error: {
          code: "circuit_open",
          message: `connector circuit breaker is open — ${itemCount} for_each iteration(s) not scheduled`,
        },
      },
    };
  }
  return { failure: null, baseUrl };
}

async function settleCollectionFailure(
  env: RunEnv,
  state: RunState,
  frame: StepFrame,
  failedResult: StepResult,
): Promise<StepVerdict> {
  const { step } = frame;
  const failureOutcome: RunStepOutcome = { result: failedResult, scope_value: undefined };
  state.scope[step.id] = envelopeFor(failureOutcome);
  state.lastOutput = undefined;
  await finalizeStepRow(
    env.db,
    frame.step_row_id,
    failedResult.status,
    {
      status: failedResult.status,
      duration_ms: failedResult.duration_ms ?? 0,
      retry_count: failedResult.retry_count ?? 0,
      error: failedResult.error ?? null,
    },
    {
      tenant_id: env.tenant_id,
      output_preview: null,
      result_preview: null,
      result_storage_uri: null,
    },
  );
  state.stepSummaries.push(failedContainerStepSummary(step, frame.index, failedResult));
  return { status: failedResult.status, error: failedResult.error };
}

async function settleEmptyCollection(
  env: RunEnv,
  state: RunState,
  frame: StepFrame,
  warnResult: StepResult,
): Promise<StepVerdict> {
  const { step } = frame;
  state.scope[step.id] = wrapEnvelope({
    data: [],
    duration_ms: warnResult.duration_ms ?? 0,
    error: null,
  });
  state.lastOutput = [];
  for (const w of warnResult.warnings ?? []) {
    state.warnings.push({ ...w, step_key: step.id });
  }
  await finalizeStepRow(
    env.db,
    frame.step_row_id,
    "succeeded",
    {
      status: "succeeded",
      duration_ms: warnResult.duration_ms ?? 0,
      retry_count: 0,
    },
    {
      tenant_id: env.tenant_id,
      output_preview: [],
      result_preview: null,
      result_storage_uri: null,
    },
  );
  state.stepSummaries.push({
    step_key: step.id,
    step_index: frame.index,
    kind: step.kind,
    status: "succeeded",
    duration_ms: warnResult.duration_ms ?? null,
    retry_count: 0,
    error: null,
    request_meta: null,
    output_preview: [],
  });
  return { status: "succeeded", error: null };
}

export async function runForEachStep(
  env: RunEnv,
  plan: RunPlan,
  state: RunState,
  frame: StepFrame,
  forEach: string,
): Promise<StepVerdict> {
  const { step, ctx } = frame;
  const { clock, tenant_id, execution_id, signal } = env;
  const forEachStart = clock.now();
  const collectionResult = await resolveForEachCollection(
    forEach,
    step.id,
    state.scope,
    forEachStart,
    {
      now_ms: ctx.started_at.getTime(),
      seed: `${env.evaluationSeed}:${step.id}`,
    },
    ctx.signal,
  );
  const preflight =
    collectionResult.kind === "collection"
      ? await preflightFanOut(env, step, collectionResult.items.length, forEachStart)
      : { failure: null, baseUrl: null };
  if (collectionResult.kind === "failure" || preflight.failure !== null) {
    const failedResult = preflight.failure ?? (collectionResult as { result: StepResult }).result;
    return settleCollectionFailure(env, state, frame, failedResult);
  }
  if (collectionResult.kind === "empty_warning") {
    return settleEmptyCollection(env, state, frame, collectionResult.result);
  }
  const items = collectionResult.items;
  const slots: (Record<string, unknown> | undefined)[] = new Array(items.length);
  let forEachFailure: RunStepOutcome | null = null;

  const runIteration = async (itemIdx: number): Promise<void> => {
    const item = items[itemIdx];
    const childScope = buildLoopChildScope(state.scope, item, itemIdx);
    const iterStepRowId = await insertStepRow(env.db, {
      tenant_id,
      execution_id,
      step_key: `${step.id}[${itemIdx}]`,
      step_index: frame.index,
      kind: step.kind,
    });
    if (env.opts.hold_writes) {
      const heldDep = findHeldDependency(plan.dag, step.id, (sid) =>
        state.heldOrSkippedStepIds.has(sid),
      );
      if (heldDep) {
        const skippedEnv = wrapEnvelope({
          data: null,
          duration_ms: 0,
          error: heldDependencyError(heldDep),
        });
        slots[itemIdx] = { [step.id]: skippedEnv };
        return;
      }
    }
    const iterCtx: StepRunContext = {
      ...ctx,
      scope: childScope,
      evaluation_seed: `${ctx.evaluation_seed ?? execution_id}:for_each:${step.id}:${itemIdx}`,
      step_row_id: iterStepRowId,
    };
    const iterOutcome = await runInstrumentedStep(env, iterCtx, childScope, {
      step_id: step.id,
      step_kind: step.kind,
      for_each_index: itemIdx,
    });
    recordHeldChild(state, frame, `${step.id}[${itemIdx}]`, iterCtx, iterOutcome);
    childScope[step.id] = envelopeFor(iterOutcome);
    slots[itemIdx] = {
      [step.id]: bodyEnvelopeForLoopAccumulator(iterOutcome),
    };
    if (forEachFailure === null && isFailedStepStatus(iterOutcome.result.status)) {
      forEachFailure = iterOutcome;
    }
  };

  const concurrency = resolveForEachConcurrency(step, items.length, preflight.baseUrl);
  if (concurrency <= 1) {
    for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
      if (signal.aborted) break;
      await runIteration(itemIdx);
    }
  } else {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted) return;
        const myIdx = cursor++;
        if (myIdx >= items.length) return;
        await runIteration(myIdx);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  }
  const iterationResults: unknown[] = slots.filter((s) => s !== undefined);
  if (frame.childHeld) state.heldOrSkippedStepIds.add(step.id);
  recordForEachExecution({
    tenant_id,
    step_kind: step.kind,
    items: items.length,
    concurrency,
    explicit: (step as { for_each_concurrency?: number }).for_each_concurrency != null,
    duration_ms: clock.now() - forEachStart,
  });
  state.scope[step.id] = wrapEnvelope({
    data: iterationResults,
    duration_ms: clock.now() - forEachStart,
    error: null,
  });
  state.lastOutput = iterationResults;
  if (iterationResults.length > 0) {
    const tally = tallyIterations(iterationResults, classifyBodyIteration);
    if (tally.offloaded > 0) {
      recordLoopIterationsOffloaded({ tenant_id, count: tally.offloaded });
    }
    if (tally.productive === 0) {
      state.warnings.push(forEachBodyEmptyWarning(step.id, iterationResults.length));
    }
  }
  const forEachDurationMs = clock.now() - forEachStart;
  const verdict = forEachVerdict((forEachFailure as RunStepOutcome | null)?.result ?? null);
  await finalizeStepRow(
    env.db,
    frame.step_row_id,
    verdict.status,
    {
      status: verdict.status,
      duration_ms: forEachDurationMs,
      retry_count: 0,
      ...(verdict.error ? { error: verdict.error } : {}),
    },
    {
      tenant_id,
      output_preview: previewOffloadRefs(iterationResults),
      result_preview: null,
      result_storage_uri: null,
    },
  );
  state.stepSummaries.push({
    step_key: step.id,
    step_index: frame.index,
    kind: step.kind,
    status: verdict.status,
    duration_ms: forEachDurationMs,
    retry_count: 0,
    error: verdict.error,
    request_meta: null,
    output_preview: previewOffloadRefs(iterationResults),
  });
  return verdict;
}
