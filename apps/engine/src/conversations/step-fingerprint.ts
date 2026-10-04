import { createHash } from "node:crypto";
import { canonicalJson } from "./text-line-diff.ts";
import type { WorkflowDraftStepPreview } from "./types.ts";

export function stepFingerprint(step: Record<string, unknown>): string {
  const id = typeof step.id === "string" ? step.id : "";
  const hash = createHash("sha256").update(canonicalJson(step)).digest("hex").slice(0, 16);
  return `${id}#${hash}`;
}

export function fingerprintsById(
  steps: ReadonlyArray<Record<string, unknown>>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const step of steps) {
    if (step && typeof step === "object" && typeof step.id === "string") {
      out.set(step.id, stepFingerprint(step));
    }
  }
  return out;
}

export function stampStepTraceFingerprints<T extends { step_id: string; fingerprint?: string }>(
  traces: T[],
  steps: ReadonlyArray<Record<string, unknown>>,
): T[] {
  const byId = fingerprintsById(steps);
  return traces.map((trace) => {
    const fp = byId.get(trace.step_id);
    return fp ? { ...trace, fingerprint: fp } : trace;
  });
}

export function retainFingerprintValidTraces(
  traces: ReadonlyArray<WorkflowDraftStepPreview>,
  steps: ReadonlyArray<Record<string, unknown>>,
): WorkflowDraftStepPreview[] {
  const byId = fingerprintsById(steps);
  return traces.filter(
    (trace) =>
      typeof trace.fingerprint === "string" && byId.get(trace.step_id) === trace.fingerprint,
  );
}

export function pruneTracesForMutation(
  traces: ReadonlyArray<WorkflowDraftStepPreview>,
  prevSteps: ReadonlyArray<Record<string, unknown>>,
  nextSteps: ReadonlyArray<Record<string, unknown>>,
): WorkflowDraftStepPreview[] {
  const prevById = fingerprintsById(prevSteps);
  const nextById = fingerprintsById(nextSteps);
  const out: WorkflowDraftStepPreview[] = [];
  for (const trace of traces) {
    const nextFp = nextById.get(trace.step_id);
    if (!nextFp) continue;
    if (typeof trace.fingerprint === "string") {
      if (trace.fingerprint === nextFp) out.push(trace);
      continue;
    }
    const prevFp = prevById.get(trace.step_id);
    if (prevFp !== undefined && prevFp === nextFp) {
      out.push({ ...trace, fingerprint: nextFp });
    }
  }
  return out;
}
