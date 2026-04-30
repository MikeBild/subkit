// `assertLoopAuthoringInspection` — gate that refuses a workflow draft
// whose loop steps depend on upstream step output the LLM has never
// actually seen.
//
// The pre-fix failure mode (sessions ebd66982 / 86de186b): the LLM
// authors a loop with `over: "$scope.X.data.projects"`, the path is
// wrong, the loop returns 0 rows, and the LLM cycles through 4–9
// variants of the same path before giving up. Each retry costs a full
// dry-run cycle plus 20–30k tokens.
//
// The contract this gate enforces: before adding (or replacing) a
// `loop` step that references some `$scope.<X>...` or `$steps.<X>...`
// path, either:
//   1) `inspect_workflow_draft` was called since the upstream step's
//      most recent mutation (the `workflow_inspected` checkpoint is
//      `fresh`), AND a `latest_preview` for X exists with a populated
//      `scope_at_step`, OR
//   2) the upstream step is a `transform` over `$input` (no other
//      step shapes to inspect), in which case the gate doesn't apply.
//
// When the gate refuses, it returns the typed `loop_authoring_requires_inspect`
// error code with concrete `next_best_actions` so the LLM converges
// in one round-trip instead of guessing.

import { extractStepIdReferences } from "../../workflows/levenshtein.ts";
import type { DraftDocument, WorkflowDraftStepPreview } from "../types.ts";

export interface LoopGateBlock {
  /** id of the loop step that triggered the block. */
  loop_step_id: string;
  /** Upstream step id the loop's `over` / `data_selector` references. */
  referenced_step_id: string;
  /** Source expression text (truncated) so the LLM sees what it wrote. */
  source: string;
  /** Why the gate refused — one of the enumerated reasons. */
  reason: "no_preview_for_referenced_step" | "preview_missing_scope" | "no_dry_run_yet";
}

export interface LoopGateResult {
  ok: boolean;
  blocks: LoopGateBlock[];
}

interface LoopLikeStep {
  id: string;
  kind: "loop";
  over?: unknown;
  data_selector?: unknown;
}

function isLoopStep(step: unknown): step is LoopLikeStep {
  return (
    typeof step === "object" &&
    step !== null &&
    (step as { kind?: unknown }).kind === "loop" &&
    typeof (step as { id?: unknown }).id === "string"
  );
}

function pickLoopSource(step: LoopLikeStep): string | null {
  if (typeof step.over === "string") return step.over;
  if (typeof step.data_selector === "string") return step.data_selector;
  return null;
}

/** Optional set of connector slugs the operator successfully probed
 *  during the current conversation. When the loop's referenced step
 *  is a `request` step routed through one of these connectors, the
 *  probe counts as shape evidence and the gate is exempted — even
 *  without a recorded workflow dry_run. Mirrors the reference impl's
 *  call_system → build_tool → run_tool flow, where probes are the
 *  primary shape-discovery surface. */
export interface LoopAuthoringGateOptions {
  probedConnectorSlugs?: ReadonlySet<string>;
}

/**
 * Walk the draft's loop steps. For each, extract the referenced step
 * ids from the `over` / `data_selector` expression. Cross-reference
 * against the latest dry-run's `step_traces` slot. Return the list of
 * blocks (empty when the gate is satisfied).
 */
export function evaluateLoopAuthoringGate(
  workflow: { steps: ReadonlyArray<Record<string, unknown>> },
  latestPreview: DraftDocument["latest_preview"],
  options: LoopAuthoringGateOptions = {},
): LoopGateResult {
  const blocks: LoopGateBlock[] = [];
  const traces: WorkflowDraftStepPreview[] = Array.isArray(latestPreview?.step_traces)
    ? latestPreview!.step_traces!
    : [];
  const traceById = new Map<string, WorkflowDraftStepPreview>();
  for (const t of traces) traceById.set(t.step_id, t);

  const stepIds = new Set<string>();
  // Map step_id → the underlying step object so we can check whether
  // the referenced step is a `request` against a probed connector.
  const stepById = new Map<string, Record<string, unknown>>();
  for (const step of workflow.steps) {
    if (
      typeof step === "object" &&
      step !== null &&
      typeof (step as { id?: unknown }).id === "string"
    ) {
      const id = (step as { id: string }).id;
      stepIds.add(id);
      stepById.set(id, step as Record<string, unknown>);
    }
  }

  const probedSlugs = options.probedConnectorSlugs ?? new Set<string>();

  /**
   * Walk a step's structural ancestry up to a depth-bounded limit and
   * decide whether the step transitively depends only on probed
   * connectors. Pre-fix, the gate exempted only DIRECT references to a
   * probed-connector request step; a `loop → transform → request`
   * chain (the canonical reshape pattern) failed the gate because the
   * intermediate transform had no `connector_slug`. Transitively
   * propagating the exemption matches the reference impl's flow where
   * a probed system feeds an arbitrary number of derived transforms
   * before driving a loop.
   */
  function transitivelyExempt(stepId: string, seen = new Set<string>()): boolean {
    if (seen.has(stepId) || seen.size > 16) return false;
    seen.add(stepId);
    const s = stepById.get(stepId);
    if (!s) return false;
    if (typeof s.connector_slug === "string" && probedSlugs.has(s.connector_slug as string)) {
      return true;
    }
    if ((s as { kind?: unknown }).kind !== "transform") return false;
    const expr =
      typeof s.expression === "string"
        ? (s.expression as string)
        : typeof s.data_selector === "string"
          ? (s.data_selector as string)
          : null;
    if (!expr) return false;
    const upstream = extractStepIdReferences(expr);
    if (upstream.length === 0) return false;
    return upstream.some((u) => transitivelyExempt(u, seen));
  }

  for (const step of workflow.steps) {
    if (!isLoopStep(step)) continue;
    const source = pickLoopSource(step);
    if (!source) continue;
    const referenced = extractStepIdReferences(source);
    if (referenced.length === 0) continue;
    for (const ref of referenced) {
      // Only enforce on references that point at SIBLING steps in
      // this draft. References to step ids that don't exist are
      // already caught by `validateStepReferences` earlier in the
      // pipeline.
      if (!stepIds.has(ref)) continue;
      // Probe-evidence exemption (transitive): when the referenced
      // step is a `request` against a probed connector — directly or
      // through a chain of transforms — the probe counts as shape
      // evidence and the gate is exempted.
      if (transitivelyExempt(ref)) continue;
      const trace = traceById.get(ref);
      if (!trace) {
        blocks.push({
          loop_step_id: step.id,
          referenced_step_id: ref,
          source: source.length > 200 ? `${source.slice(0, 200)}…` : source,
          reason: traces.length === 0 ? "no_dry_run_yet" : "no_preview_for_referenced_step",
        });
        continue;
      }
      if (!trace.scope_at_step) {
        blocks.push({
          loop_step_id: step.id,
          referenced_step_id: ref,
          source: source.length > 200 ? `${source.slice(0, 200)}…` : source,
          reason: "preview_missing_scope",
        });
      }
    }
  }
  return { ok: blocks.length === 0, blocks };
}
