import type { Db } from "../../db/client.ts";
import type { RunLlmBudget } from "../../llm/accounting/index.ts";
import type { ResolvedAuthorityReference } from "../../llm/substitution/resolver.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import type { buildStepDag } from "../../workflows/dag.ts";
import type { CallStep, StepDef, WorkflowDef } from "../../workflows/types.ts";
import type { CallerContext } from "../caller-context.ts";
import type { CallerOrigin, resolveExecutionCallerActor } from "../caller-origin.ts";
import type { Clock, IdGen } from "../clock.ts";
import { decideStepFailure, heldChildStepSummary, skippedAfterFailure } from "../core/run.ts";
import type { ExecutionStatus, StepStatus } from "../core/status.ts";
import type { resolveDefinition } from "../resolve-definition.ts";
import { type RunStepOutcome, runStep } from "../step-runner.ts";
import {
  type ExecutionMode,
  hasHeldOutput,
  type RequestSource,
  type RunOptions,
  type RunResult,
  type StepResult,
  type StepRunContext,
} from "../types.ts";

export type ResolvedRunDefinition = Awaited<ReturnType<typeof resolveDefinition>>;

export type CallStepRunner = (
  ctx: StepRunContext,
  step: CallStep,
  scope: Record<string, unknown>,
) => Promise<StepResult>;

export interface RunEnv {
  db: Db;
  tenant_id: string;
  execution_id: string;
  def: WorkflowDef;
  resolved: ResolvedRunDefinition;
  opts: RunOptions;
  normalizedInput: unknown;
  caller: CallerContext | null;
  caller_origin: CallerOrigin;
  callerActor: ReturnType<typeof resolveExecutionCallerActor>;
  execution_privacy: "sensitive" | undefined;
  sensitiveMetadataPreview: boolean;
  request_source: RequestSource;
  parent_execution_id: string | null;
  execution_mode: ExecutionMode;
  depth: number;
  preparedReferences: ResolvedAuthorityReference[] | undefined;
  evaluationInstant: Date;
  execution_started_at: number;
  evaluationSeed: string;
  ownConnectorCredentials: boolean;
  attempt: number;
  beforeExternalRequest: (
    step_key: string,
  ) => NonNullable<StepRunContext["before_external_request"]>;
  llmBudget: RunLlmBudget;
  abort: AbortController;
  totalTimeout: AbortController;
  totalTimer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  workflowDeadlineMs: number;
  clock: Clock;
  ids: IdGen;
  runCall: CallStepRunner;
}

export interface RunPlan {
  dag: ReturnType<typeof buildStepDag>;
  executionOrder: ReadonlyArray<string>;
  stepIndexById: ReadonlyMap<string, number>;
  containerChildIds: ReadonlySet<string>;
}

export interface RunState {
  scope: Record<string, unknown>;
  stepSummaries: RunResult["steps"];
  warnings: NonNullable<RunResult["warnings"]>;
  skippedStepIds: Set<string>;
  heldOrSkippedStepIds: Set<string>;
  lastOutput: unknown;
  lastError: { code: string; message: string } | null;
  failedStepId: string | null;
  finalStatus: ExecutionStatus;
  validationError: { code: string; message: string; details?: unknown } | null;
  budgetPark: { step_id: string; step_row_id: string } | null;
}

export interface StepFrame {
  step: StepDef;
  index: number;
  topoIndex: number;
  step_row_id: string;
  ctx: StepRunContext;
  childHeld: boolean;
}

export type StepVerdict = { status: StepStatus; error: StepResult["error"] };

export function initialRunState(env: RunEnv): RunState {
  return {
    scope: { ...env.opts.initial_scope, $input: env.normalizedInput, $caller: env.caller },
    stepSummaries: [],
    warnings: [],
    skippedStepIds: new Set<string>(),
    heldOrSkippedStepIds: new Set<string>(),
    lastOutput: null,
    lastError: null,
    failedStepId: null,
    finalStatus: "succeeded",
    validationError: null,
    budgetPark: null,
  };
}

export function buildStepContext(
  env: RunEnv,
  step: StepDef,
  step_index: number,
  step_row_id: string,
  scope: Record<string, unknown>,
  evaluation_seed: string,
): StepRunContext {
  return {
    ...(env.preparedReferences ? { prepared_workflow_references: env.preparedReferences } : {}),
    before_external_request: env.beforeExternalRequest(step.id),
    db: env.db,
    tenant_id: env.tenant_id,
    execution_id: env.execution_id,
    workflow_id: env.resolved.workflow_id,
    workflow_version_id: env.resolved.workflow_version_id,
    request_source: env.request_source,
    parent_execution_id: env.parent_execution_id,
    depth: env.depth,
    signal: env.signal,
    scope,
    started_at: env.evaluationInstant,
    evaluation_seed,
    workflow_slug: env.resolved.workflow_slug,
    trace_id: env.opts.trace_id ?? null,
    principal: env.opts.principal ?? null,
    caller_context: env.caller,
    caller_origin: env.caller_origin,
    execution_privacy: env.execution_privacy,
    execution_mode: env.execution_mode,
    step,
    step_index,
    step_row_id,
    llm_budget: env.llmBudget,
    clock: env.clock,
    ids: env.ids,
    persist_workflow_refs: env.resolved.persist_workflow_refs,
    workflow_deadline_ms: env.workflowDeadlineMs,
    ...(env.ownConnectorCredentials ? { own_connector_credentials: true } : {}),
    ...(env.opts.hold_writes ? { hold_writes: true } : {}),
  };
}

export function runInstrumentedStep(
  env: RunEnv,
  ctx: StepRunContext,
  scope: Record<string, unknown>,
  fields: Record<string, unknown>,
): Promise<RunStepOutcome> {
  return instrument({
    module: "execution",
    action: "step",
    level: "debug",
    thresholdMs: 1000,
    fields,
    fn: () =>
      runStep(ctx, scope, env.normalizedInput, async ({ ctx: cctx, step: cstep, scope: cscope }) =>
        env.runCall(cctx, cstep as CallStep, cscope),
      ),
  });
}

export function recordHeldChild(
  state: RunState,
  frame: StepFrame,
  key: string,
  child: StepRunContext,
  outcome: RunStepOutcome,
): void {
  if (hasHeldOutput(outcome.result)) frame.childHeld = true;
  for (const warning of outcome.result.warnings ?? []) {
    state.warnings.push({ ...warning, step_key: key });
  }
  if (!outcome.result.held) return;
  frame.childHeld = true;
  state.stepSummaries.push(heldChildStepSummary(key, frame.index, child.step.kind, outcome.result));
}

export function settleStepVerdict(
  env: RunEnv,
  plan: RunPlan,
  state: RunState,
  frame: StepFrame,
  verdict: StepVerdict,
): "continue" | "stop" {
  if (verdict.status === "succeeded") return "continue";
  const decision = decideStepFailure(frame.step, verdict.status, verdict.error);
  if (decision.kind === "fail") {
    state.lastError = decision.error;
    state.failedStepId = frame.step.id;
    state.finalStatus = decision.status;
    state.stepSummaries.push(
      ...skippedAfterFailure(
        plan.executionOrder,
        frame.topoIndex,
        plan.stepIndexById,
        env.def.steps,
      ),
    );
    return "stop";
  }
  state.warnings.push(decision.warning);
  return "continue";
}
