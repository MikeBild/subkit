// `evaluateTransformAuthoringGate` — symmetric counterpart to
// `evaluateLoopAuthoringGate` for `transform` steps.
//
// Pre-fix failure mode (transcript: `get-last-3-gmail-messages with
// human output`): the LLM authored a transform step whose JSONata
// expression referenced `$scope.list_messages.data.messages.[…]`
// BEFORE a dry-run had recorded `list_messages`' actual response shape.
// With no shape evidence, the model fell back to placeholder strings
// (`"item 1"`, `"item 2"`) and the run "succeeded" with garbage
// output. Three retries to converge on the right field path; each
// retry burned a full preview cycle.
//
// The contract this gate enforces: before adding (or replacing) a
// `transform` step whose `expression` cites `$scope.<X>...` /
// `$steps.<X>...` for a sibling step X, a dry-run must have already
// recorded X's `output_preview` in `latest_preview.step_traces`. When
// the gate refuses, it returns the typed `transform_authoring_requires_inspect`
// error code with concrete `next_best_actions` so the LLM converges in
// one round-trip.

import { extractStepIdReferences } from "../../workflows/levenshtein.ts";
import type { DraftDocument, WorkflowDraftStepPreview } from "../types.ts";

export interface TransformGateBlock {
  /** id of the transform step that triggered the block. */
  transform_step_id: string;
  /** Upstream step id the transform's expression references. */
  referenced_step_id: string;
  /** Source expression text (truncated) so the LLM sees what it wrote. */
  expression: string;
  /** Why the gate refused — one of the enumerated reasons. */
  reason: "no_preview_for_referenced_step" | "no_dry_run_yet";
}

export interface TransformGateResult {
  ok: boolean;
  blocks: TransformGateBlock[];
}

interface TransformLikeStep {
  id: string;
  kind: "transform";
  expression?: unknown;
}

function isTransformStep(step: unknown): step is TransformLikeStep {
  return (
    typeof step === "object" &&
    step !== null &&
    (step as { kind?: unknown }).kind === "transform" &&
    typeof (step as { id?: unknown }).id === "string"
  );
}

/**
 * Walk the draft's transform steps. For each, extract the referenced
 * step ids from its `expression`. Cross-reference against the latest
 * dry-run's `step_traces` slot. Return the list of blocks (empty when
 * the gate is satisfied).
 *
 * Transforms that read only from `$input` (no `$scope`/`$steps` refs)
 * are exempt — there is no upstream step to inspect.
 */
export function evaluateTransformAuthoringGate(
  workflow: { steps: ReadonlyArray<Record<string, unknown>> },
  latestPreview: DraftDocument["latest_preview"],
): TransformGateResult {
  const blocks: TransformGateBlock[] = [];
  const traces: WorkflowDraftStepPreview[] = Array.isArray(latestPreview?.step_traces)
    ? latestPreview.step_traces
    : [];
  const traceById = new Map<string, WorkflowDraftStepPreview>();
  for (const t of traces) traceById.set(t.step_id, t);

  const stepIds = new Set<string>();
  for (const step of workflow.steps) {
    if (
      typeof step === "object" &&
      step !== null &&
      typeof (step as { id?: unknown }).id === "string"
    ) {
      stepIds.add((step as { id: string }).id);
    }
  }

  for (const step of workflow.steps) {
    if (!isTransformStep(step)) continue;
    const expr = typeof step.expression === "string" ? step.expression : "";
    if (!expr) continue;
    const referenced = extractStepIdReferences(expr);
    if (referenced.length === 0) continue;
    for (const ref of referenced) {
      // Only enforce on references that point at SIBLING steps in
      // this draft. References to step ids that don't exist are
      // caught earlier by `validateStepReferences`.
      if (!stepIds.has(ref)) continue;
      // Self-reference (a transform reading its own output) is
      // impossible at runtime — skip.
      if (ref === step.id) continue;
      const trace = traceById.get(ref);
      if (!trace || trace.output_preview === undefined || trace.output_preview === null) {
        blocks.push({
          transform_step_id: step.id,
          referenced_step_id: ref,
          expression: expr.length > 200 ? `${expr.slice(0, 200)}…` : expr,
          reason: traces.length === 0 ? "no_dry_run_yet" : "no_preview_for_referenced_step",
        });
      }
    }
  }
  return { ok: blocks.length === 0, blocks };
}
