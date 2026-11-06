import { failureStatusOf, type StepStatus, type TerminalExecutionStatus } from "./status.ts";

export interface DependencyEdges {
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

export interface BranchArms {
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

export interface StepError {
  code: string;
  message: string;
}

export interface ContinuedStepWarning {
  code: "step_failed_continued";
  step_key: string;
  message: string;
  details: { step_status: StepStatus; error_code: string };
}

export type StepFailureDecision =
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

export interface SkippedStepSummary {
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
