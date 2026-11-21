import type { OutputContractVerdict } from "../state.ts";
import {
  HELD_PREVIEW_WARNING_CODE,
  type RunOptions,
  type RunResult,
  type SensitiveCheckVerdict,
  type StepResult,
} from "../types.ts";
import {
  type ExecutionStatus,
  failureStatusOf,
  type StepStatus,
  type TerminalExecutionStatus,
} from "./status.ts";

interface DependencyEdges {
  edges: ReadonlyArray<{ from: string; to: string }>;
}

export function findHeldDependency(
  dag: DependencyEdges,
  stepId: string,
  isMissing: (id: string) => boolean,
): string | null {
  for (const e of dag.edges) {
    if (e.from !== stepId) continue;
    if (e.to === stepId) continue;
    if (isMissing(e.to)) return e.to;
  }
  return null;
}

interface BranchArms {
  then_steps?: readonly string[] | undefined;
  else_steps?: readonly string[] | undefined;
}

export function untakenArmStepIds(branch: BranchArms, output: unknown): readonly string[] {
  const arm = (output as { arm?: string } | null | undefined)?.arm;
  return arm === "then" ? (branch.else_steps ?? []) : (branch.then_steps ?? []);
}

export function branchArmStepIds(branch: BranchArms): string[] {
  return [...(branch.then_steps ?? []), ...(branch.else_steps ?? [])];
}

interface StepError {
  code: string;
  message: string;
}

interface ContinuedStepWarning {
  code: "step_failed_continued";
  step_key: string;
  message: string;
  details: { step_status: StepStatus; error_code: string };
}

type StepFailureDecision =
  | { kind: "fail"; status: TerminalExecutionStatus; error: StepError }
  | { kind: "continue"; warning: ContinuedStepWarning };

const DEFAULT_STEP_ERROR: StepError = { code: "step_failed", message: "step failed" };

export function stepErrorOf(error: StepError | null | undefined): StepError {
  return error ?? DEFAULT_STEP_ERROR;
}

export function continuedStepWarning(
  stepId: string,
  status: StepStatus,
  error: StepError | null | undefined,
): ContinuedStepWarning {
  const stepError = stepErrorOf(error);
  return {
    code: "step_failed_continued",
    step_key: stepId,
    message: `step "${stepId}" ${status} (${stepError.code}: ${stepError.message}) but declares on_error:"continue" — the run continued`,
    details: { step_status: status, error_code: stepError.code },
  };
}

export function stopsRunOnFailure(step: { on_error?: "fail" | "continue" | undefined }): boolean {
  return (step.on_error ?? "fail") === "fail";
}

export function decideStepFailure(
  step: { id: string; on_error?: "fail" | "continue" | undefined },
  status: StepStatus,
  error: StepError | null | undefined,
): StepFailureDecision {
  if (stopsRunOnFailure(step))
    return { kind: "fail", status: failureStatusOf(status), error: stepErrorOf(error) };
  return { kind: "continue", warning: continuedStepWarning(step.id, status, error) };
}

interface SkippedStepSummary {
  step_key: string;
  step_index: number;
  kind: string;
  status: "skipped";
  duration_ms: 0;
  retry_count: 0;
  error: StepError;
  request_meta: null;
}

export function skippedAfterFailure(
  executionOrder: readonly string[],
  failedAt: number,
  stepIndexById: ReadonlyMap<string, number>,
  steps: ReadonlyArray<{ id: string; kind: string }>,
): SkippedStepSummary[] {
  const skipped: SkippedStepSummary[] = [];
  for (let j = failedAt + 1; j < executionOrder.length; j++) {
    const remainingId = executionOrder[j] as string;
    const remainingIdx = stepIndexById.get(remainingId) ?? j;
    const s = steps[remainingIdx] as { id: string; kind: string };
    skipped.push({
      step_key: s.id,
      step_index: remainingIdx,
      kind: s.kind,
      status: "skipped",
      duration_ms: 0,
      retry_count: 0,
      error: { code: "skipped", message: "skipped due to upstream failure" },
      request_meta: null,
    });
  }
  return skipped;
}

interface ContainerStep {
  branches?: ReadonlyArray<readonly string[] | undefined> | undefined;
  body?: readonly string[] | undefined;
}

export function containerChildStepIds(steps: ReadonlyArray<{ kind: string }>): Set<string> {
  const ids = new Set<string>();
  for (const s of steps) {
    if (s.kind === "parallel") {
      for (const branch of (s as ContainerStep).branches ?? []) {
        for (const id of branch ?? []) ids.add(id);
      }
    } else if (s.kind === "loop") {
      for (const id of (s as ContainerStep).body ?? []) ids.add(id);
    }
  }
  return ids;
}

export type StepEntry =
  | { kind: "aborted" }
  | { kind: "skipped" }
  | { kind: "fixture"; envelope: unknown; data: unknown }
  | { kind: "held"; dependency: string }
  | { kind: "run" };

export function classifyStepEntry(facts: {
  aborted: boolean;
  skipped: boolean;
  containerChild: boolean;
  fixture: unknown;
  heldDependency: string | null;
}): StepEntry {
  if (facts.aborted) return { kind: "aborted" };
  if (facts.skipped || facts.containerChild) return { kind: "skipped" };
  if (facts.fixture !== undefined)
    return {
      kind: "fixture",
      envelope: facts.fixture,
      data: (facts.fixture as { data?: unknown }).data,
    };
  if (facts.heldDependency) return { kind: "held", dependency: facts.heldDependency };
  return { kind: "run" };
}

type StepSummary = RunResult["steps"][number];

interface SummaryStep {
  id: string;
  kind: string;
}

export function abortedStepSummary(step: SummaryStep, index: number): StepSummary {
  return {
    step_key: step.id,
    step_index: index,
    kind: step.kind,
    status: "aborted",
    duration_ms: 0,
    retry_count: 0,
    error: { code: "aborted", message: "execution aborted" },
  };
}

export function branchSkippedStepSummary(step: SummaryStep, index: number): StepSummary {
  return {
    step_key: step.id,
    step_index: index,
    kind: step.kind,
    status: "skipped",
    duration_ms: 0,
    retry_count: 0,
    error: { code: "skipped", message: "skipped by branch control flow" },
  };
}

export function fixtureStepSummary(step: SummaryStep, index: number, data: unknown): StepSummary {
  return {
    step_key: step.id,
    step_index: index,
    kind: step.kind,
    status: "succeeded",
    duration_ms: 0,
    retry_count: 0,
    error: null,
    output_preview: data,
  };
}

export function heldDependencyError(dependency: string): StepError {
  return {
    code: "skipped_dependency_held",
    message: `skipped (depends on held step "${dependency}")`,
  };
}

export function heldSkippedStepSummary(
  step: SummaryStep,
  index: number,
  dependency: string,
): StepSummary {
  return {
    step_key: step.id,
    step_index: index,
    kind: step.kind,
    status: "skipped",
    duration_ms: 0,
    retry_count: 0,
    error: heldDependencyError(dependency),
  };
}

export function heldChildStepSummary(
  key: string,
  index: number,
  kind: string,
  result: StepResult,
): StepSummary {
  return {
    step_key: key,
    step_index: index,
    kind,
    status: result.status,
    duration_ms: result.duration_ms ?? null,
    retry_count: result.retry_count ?? 0,
    error: result.error ?? null,
    request_meta: result.request_meta ?? null,
    held: true,
    ...(result.held_request ? { held_request: result.held_request } : {}),
  };
}

export function failedContainerStepSummary(
  step: SummaryStep,
  index: number,
  result: StepResult,
): StepSummary {
  return {
    step_key: step.id,
    step_index: index,
    kind: step.kind,
    status: result.status,
    duration_ms: result.duration_ms ?? null,
    retry_count: result.retry_count ?? 0,
    error: result.error ?? null,
    request_meta: null,
  };
}

export function outcomeStepSummary(
  step: SummaryStep,
  index: number,
  result: StepResult,
  outputPreview: unknown,
  rawOutput: unknown,
): StepSummary {
  return {
    step_key: step.id,
    step_index: index,
    kind: step.kind,
    status: result.status,
    duration_ms: result.duration_ms ?? null,
    retry_count: result.retry_count ?? 0,
    error: result.error ?? null,
    request_meta: result.request_meta ?? null,
    ...(result.held
      ? {
          held: true as const,
          ...(result.held_request ? { held_request: result.held_request } : {}),
        }
      : {}),
    ...(outputPreview !== undefined ? { output_preview: outputPreview } : {}),
    ...(rawOutput !== undefined ? { raw_preview: rawOutput } : {}),
  };
}

export function isFailedStepStatus(status: StepStatus): boolean {
  return status === "failed" || status === "aborted" || status === "timed_out";
}

type ContainerStatus = "succeeded" | "failed" | "aborted" | "timed_out";

export function forEachVerdict(failure: StepResult | null): {
  status: ContainerStatus;
  error: StepError | null;
} {
  if (!failure) return { status: "succeeded", error: null };
  return {
    status: failure.status as ContainerStatus,
    error: failure.error ?? { code: "loop_body_failed", message: "loop body failed" },
  };
}

export function withContainerFailure<T extends { result: StepResult }>(
  outcome: T,
  failure: StepResult,
  fallback: StepError,
): T {
  return {
    ...outcome,
    result: { ...outcome.result, status: failure.status, error: failure.error ?? fallback },
  };
}

export function tallyIterations(
  iterations: readonly unknown[],
  classify: (iteration: unknown) => { productive: boolean; offloaded: boolean },
): { productive: number; offloaded: number } {
  let productive = 0;
  let offloaded = 0;
  for (const iteration of iterations) {
    const verdict = classify(iteration);
    if (verdict.offloaded) offloaded += 1;
    if (verdict.productive) productive += 1;
  }
  return { productive, offloaded };
}

type RunWarning = NonNullable<RunResult["warnings"]>[number];

function iterationsLabel(count: number): string {
  return `${count} iteration${count === 1 ? "" : "s"}`;
}

export function forEachBodyEmptyWarning(stepId: string, iterations: number): RunWarning {
  return {
    code: "loop_body_empty",
    identifier: stepId,
    message: `for_each step "${stepId}" ran ${iterationsLabel(iterations)} but no iteration produced productive output — every result was null / [] / {}`,
    step_key: stepId,
    details: {
      iterations,
      productive_iterations: 0,
      scope_shape: `$scope.${stepId}.data is an array of ${iterations} iteration objects`,
    },
  };
}

export function loopBodyEmptyWarning(stepId: string, iterations: readonly unknown[]): RunWarning {
  const sample = iterations[0];
  const bodyKeys = sample && typeof sample === "object" ? Object.keys(sample) : [];
  return {
    code: "loop_body_empty",
    identifier: stepId,
    message: `loop "${stepId}" ran ${iterationsLabel(iterations.length)} but no iteration produced productive body output — the body steps ran without errors but every result was null / [] / {}`,
    step_key: stepId,
    details: {
      iterations: iterations.length,
      productive_iterations: 0,
      body_step_ids: bodyKeys,
      scope_shape: `$scope.${stepId}.data is an array of ${iterations.length} iteration objects, each shaped { ${bodyKeys.map((k) => `${k}: { data, error, duration_ms }`).join(", ")} }`,
      example_path:
        bodyKeys.length > 0
          ? `$scope.${stepId}.data[0].${bodyKeys[0]}.data`
          : `$scope.${stepId}.data`,
    },
  };
}

export function heldWriteSteps(
  steps: readonly StepSummary[],
): Array<{ step_key: string; method: string | null }> {
  return steps
    .filter((step) => step.held === true)
    .map((step) => ({ step_key: step.step_key, method: step.held_request?.method ?? null }));
}

export function heldPreviewWarning(steps: readonly StepSummary[]): RunWarning {
  const held = steps.filter((s) => s.held === true);
  const skipped = steps.filter(
    (s) =>
      s.status === "skipped" &&
      (s.error as { code?: string } | null)?.code === "skipped_dependency_held",
  );
  const heldPart =
    held.length > 0
      ? `Preview run (hold_writes): ${held.length} write step(s) held`
      : "Preview run (hold_writes): writes held in called workflows";
  const skippedPart = skipped.length > 0 ? ` and ${skipped.length} dependent step(s) skipped` : "";
  return {
    code: HELD_PREVIEW_WARNING_CODE,
    message: `${heldPart}${skippedPart} — NOTHING was written to any external system. The returned output is from upstream read/transform steps only.`,
    step_key: "$holds",
    details: {
      held_steps: held.map((s) => s.step_key),
      skipped_steps: skipped.map((s) => s.step_key),
      would_write: held.map((s) => ({
        step: s.step_key,
        method: s.held_request?.method ?? null,
        url: s.held_request?.url ?? null,
      })),
    },
  };
}

export function sensitiveOutputSchemaCheck(
  hasSchema: boolean,
  contract: OutputContractVerdict,
): SensitiveCheckVerdict {
  if (!hasSchema) return "not_defined";
  if (contract === "passed") return "passed";
  if (contract === "violated") return "failed";
  return "not_run";
}

export function executionAuditOutcome(status: ExecutionStatus): {
  kind: "aborted" | "completed";
  result: "success" | "error";
} {
  return {
    kind: status === "aborted" ? "aborted" : "completed",
    result: status === "succeeded" ? "success" : "error",
  };
}

export function runResultError(
  validationError: StepError | null,
  lastError: StepError | null,
): StepError | null {
  return validationError
    ? { code: validationError.code, message: validationError.message }
    : lastError;
}

type SensitiveRunOptions = Pick<
  RunOptions,
  | "sensitive_metadata_preview"
  | "hold_writes"
  | "existing_execution_id"
  | "tool_approval_id"
  | "request_source"
  | "step_output_fixtures"
>;

export function allowsSensitiveMetadataPreview(
  opts: SensitiveRunOptions,
  privacy: "sensitive" | undefined,
  sourceKind: string,
): boolean {
  return (
    opts.sensitive_metadata_preview === true &&
    privacy === "sensitive" &&
    sourceKind === "draft" &&
    opts.hold_writes === true &&
    !opts.existing_execution_id &&
    !opts.tool_approval_id
  );
}

export function refusesSensitiveConversation(
  opts: SensitiveRunOptions,
  privacy: "sensitive" | undefined,
  metadataPreview: boolean,
): boolean {
  if (metadataPreview) return false;
  return (
    opts.sensitive_metadata_preview === true ||
    (privacy === "sensitive" && opts.request_source === "chat")
  );
}

interface SensitiveStep {
  kind: string;
  state_write?: unknown;
  state_read?: unknown;
}

export function sensitiveRunUnsupported(
  steps: readonly SensitiveStep[],
  opts: SensitiveRunOptions,
): boolean {
  const unsafe = steps.some(
    (step) =>
      step.kind === "wait_for_event" ||
      (step.kind === "request" && Boolean(step.state_write || step.state_read)),
  );
  return unsafe || Boolean(opts.tool_approval_id) || Boolean(opts.step_output_fixtures);
}

export function defaultCallerOrigin(
  opts: Pick<RunOptions, "caller_origin" | "existing_execution_id" | "principal">,
): "principal" | "trusted_system" | "unknown" {
  return (
    opts.caller_origin ?? (!opts.existing_execution_id && opts.principal ? "principal" : "unknown")
  );
}
