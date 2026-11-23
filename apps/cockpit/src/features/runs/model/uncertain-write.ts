export const UNCERTAIN_STATUS = "uncertain";

export const RESOLVE_WRITE_PERMISSION = "execution:abort";

export function isUncertainRun(status: string): boolean {
  return status === UNCERTAIN_STATUS;
}

interface StepFacts {
  step_key?: string | null;
  status?: string | null;
}

function failureStep(failure: unknown): string[] {
  if (!failure || typeof failure !== "object") return [];
  const stepId = (failure as { step_id?: unknown }).step_id;
  return typeof stepId === "string" && stepId.length > 0 ? [stepId] : [];
}

export function uncertainStepKeys(
  run: { status: string; failure?: unknown },
  steps: readonly StepFacts[],
): string[] {
  if (!isUncertainRun(run.status)) return [];
  const marked = steps
    .filter((step) => step.status === UNCERTAIN_STATUS)
    .flatMap((step) => (step.step_key ? [step.step_key] : []));
  return [...new Set([...failureStep(run.failure), ...marked])];
}
