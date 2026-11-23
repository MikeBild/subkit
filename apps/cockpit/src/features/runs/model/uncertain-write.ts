export const UNCERTAIN_STATUS = "uncertain";

export function isUncertainRun(status: string): boolean {
  return status === UNCERTAIN_STATUS;
}

interface StepFacts {
  step_key?: string | null;
  status?: string | null;
}

interface ErrorFacts {
  step_keys?: unknown;
  step_id?: unknown;
}

function namedKeys(error: ErrorFacts | null | undefined): string[] {
  if (!error || typeof error !== "object") return [];
  const listed = Array.isArray(error.step_keys)
    ? error.step_keys.filter((key): key is string => typeof key === "string" && key.length > 0)
    : [];
  if (listed.length > 0) return listed;
  return typeof error.step_id === "string" && error.step_id.length > 0 ? [error.step_id] : [];
}

export function uncertainStepKeys(
  run: { status: string; error?: unknown },
  steps: readonly StepFacts[],
): string[] {
  if (!isUncertainRun(run.status)) return [];
  const named = namedKeys(run.error as ErrorFacts | null | undefined);
  const keys =
    named.length > 0
      ? named
      : steps
          .filter((step) => step.status === UNCERTAIN_STATUS || step.status === "running")
          .flatMap((step) => (step.step_key ? [step.step_key] : []));
  return [...new Set(keys)];
}
