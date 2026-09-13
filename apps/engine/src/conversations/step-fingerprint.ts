// Step fingerprinting for preview-evidence retention (Fix 5,
// session 784c1b02 post-mortem).
//
// The loop/transform authoring gates demand recorded preview evidence
// (`latest_preview.step_traces[X]`) for every upstream step a loop /
// transform references. Pre-fix, every draft mutation invalidated that
// evidence wholesale, so the model lived in a deadlock: edit → evidence
// gone → next loop-bearing edit rejected (`loop_authoring_requires_
// inspect`) → dry-run required → dry-run refuses mid-edit → rebuild
// from scratch. 102 dry_run_workflow calls in one session.
//
// The retention contract mirrors the supersede-granularity invariant
// from the scheduler/skill-candidate work: evidence identity ==
// fingerprint identity. A step's fingerprint is its id plus a stable
// hash of its full definition (`canonicalJson` — key order can never
// flip the hash). Evidence recorded for a step stays valid for exactly
// as long as that step's definition is byte-identical; any change to
// the step drops ONLY that step's evidence.
//
// Scoping: fingerprints live inside `latest_preview.step_traces` on the
// conversation's draft document, which is persisted per
// (tenant, conversation). No cross-draft or cross-tenant sharing.

import { createHash } from "node:crypto";

import { canonicalJson } from "./text-line-diff.ts";
import type { WorkflowDraftStepPreview } from "./types.ts";

/**
 * Stable identity of a step definition: `<id>#<sha256[:16] of the
 * canonical JSON of the whole step object>`. Including the id keeps the
 * fingerprint self-describing in logs; including the full definition in
 * the hash means ANY field change (url, expression, headers, …)
 * invalidates evidence recorded against the old shape.
 */
export function stepFingerprint(step: Record<string, unknown>): string {
  const id = typeof step.id === "string" ? step.id : "";
  const hash = createHash("sha256").update(canonicalJson(step)).digest("hex").slice(0, 16);
  return `${id}#${hash}`;
}

/** Map step id → fingerprint for a draft's steps array. Steps without a
 *  string id are skipped (they can't carry evidence anyway). */
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

/**
 * Stamp `fingerprint` onto each trace from the matching draft step.
 * Called by the dry-run / run tools at evidence-recording time so the
 * trace carries the identity of the step shape it was recorded against.
 * Traces whose step id has no matching draft step (loop-body iteration
 * keys like `body[0]`, removed steps) are passed through unstamped.
 */
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

/**
 * Retention filter used when MERGING a new preview over existing
 * evidence (`withLatestPreview`): an existing trace survives only when
 * it carries a fingerprint that still matches the current draft step.
 * Strict on purpose — an unverifiable trace must never satisfy a gate
 * after the draft moved underneath it.
 */
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

/**
 * Mutation-time pruning (`applyWorkflowMutation`): given the pre- and
 * post-mutation step arrays, keep evidence ONLY for steps whose
 * definition is unchanged.
 *
 *   - trace has a fingerprint → keep iff it matches the post-mutation
 *     step with the same id.
 *   - trace has no fingerprint (recorded before fingerprinting existed,
 *     or synthesized by a fixture) → keep iff the step's pre- and
 *     post-mutation definitions hash identically, and stamp the
 *     fingerprint so the trace is verifiable from here on.
 *
 * Every kept trace therefore carries a fingerprint matching the new
 * draft — downstream consumers can trust `fingerprint` unconditionally.
 */
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
    if (!nextFp) continue; // step removed (or renamed) → evidence gone
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
