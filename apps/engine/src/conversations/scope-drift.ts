// authoring_scope_changed — compare each step's available_paths
// against the previous dry-run's recorded scope_at_step. When paths
// disappear (e.g. an upstream API silently drops a field between v1
// and v2), surface a non-fatal warning so the LLM notices BEFORE
// patching downstream transforms against the new shape. Pre-fix the
// LLM patched a transform against shape v1, re-ran, the API returned
// v2, the transform silently dropped fields, and the spiral was
// indistinguishable from a typo.
//
// mutation_seq guard: only compare against previous traces when the
// workflow draft hasn't been structurally rewritten in the interim.
// The previewed-checkpoint records the seq at preview time; if the
// workflow_mutation_seq has advanced past that, the step ids may have
// moved meaning and the comparison is misleading. We require: previous
// preview's stored seq matches current workflow_mutation_seq.
//
// Extracted from dry_run_workflow (single owner per concern + the
// file-size invariant).

import { buildScopeAtStep } from "../workflows/scope-shape.ts";
import type { DraftDocument } from "./types.ts";

export interface ScopeDriftWarning {
  step_key: string;
  code: string;
  message: string;
}

export function computeScopeDriftWarnings(
  draftNow: DraftDocument,
  runSteps: ReadonlyArray<{ step_key: string; output_preview?: unknown }>,
): ScopeDriftWarning[] {
  const previousTraces = draftNow.latest_preview?.step_traces ?? [];
  const previewCheckpoint = draftNow.state?.checkpoints?.workflow_previewed;
  const draftSeq = draftNow.state?.workflow_mutation_seq ?? 0;
  const previewSeq = previewCheckpoint?.mutation_seq ?? -1;
  const sameDraftAsPreview = previewSeq === draftSeq && previousTraces.length > 0;
  const previousByStep = new Map<string, { available_paths: string[] }>();
  if (sameDraftAsPreview) {
    for (const t of previousTraces) {
      if (t.scope_at_step?.available_paths) {
        previousByStep.set(t.step_id, { available_paths: t.scope_at_step.available_paths });
      }
    }
  }
  const warnings: ScopeDriftWarning[] = [];
  for (const s of runSteps) {
    const prev = previousByStep.get(s.step_key);
    if (!prev) continue;
    if (s.output_preview === undefined || s.output_preview === null) continue;
    const cur = buildScopeAtStep(s.output_preview).available_paths;
    const curSet = new Set(cur);
    const removed = prev.available_paths.filter((p) => !curSet.has(p));
    if (removed.length > 0) {
      warnings.push({
        step_key: s.step_key,
        code: "authoring_scope_changed",
        message: `step "${s.step_key}" no longer surfaces ${removed.length} previously-recorded path(s): ${removed
          .slice(0, 5)
          .map((p) => `\`${p}\``)
          .join(
            ", ",
          )}${removed.length > 5 ? `, +${removed.length - 5} more` : ""}. Downstream transforms / loops authored against the prior shape may silently drop fields.`,
      });
    }
  }
  return warnings;
}
