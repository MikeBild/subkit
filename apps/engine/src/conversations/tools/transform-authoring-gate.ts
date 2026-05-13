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
 * Optional set of connector slugs the operator successfully probed
 * during the current conversation. When the transform's referenced
 * step is a `request` against one of these connectors — directly or
 * through a chain of intermediate transforms — the probe counts as
 * shape evidence and the gate is exempted. Mirrors the loop-gate
 * `probedConnectorSlugs` exemption: probing IS the engine's primary
 * shape-discovery surface for HTTP/GraphQL connectors, and a probe
 * that returned 200 + body is functionally equivalent to a dry-run.
 */
export interface TransformAuthoringGateOptions {
  probedConnectorSlugs?: ReadonlySet<string>;
}

/**
 * Walk the draft's transform steps. For each, extract the referenced
 * step ids from its `expression`. Cross-reference against the latest
 * dry-run's `step_traces` slot. Return the list of blocks (empty when
 * the gate is satisfied).
 *
 * Transforms that read only from `$input` (no `$scope`/`$steps` refs)
 * are exempt — there is no upstream step to inspect.
 *
 * Transforms whose referenced step is a `request` against a probed
 * connector — directly or through a chain of intermediate transforms —
 * are also exempt: the probe IS the shape evidence the gate would
 * otherwise demand from a dry-run.
 */
export function evaluateTransformAuthoringGate(
  workflow: { steps: ReadonlyArray<Record<string, unknown>> },
  latestPreview: DraftDocument["latest_preview"],
  options: TransformAuthoringGateOptions = {},
): TransformGateResult {
  const blocks: TransformGateBlock[] = [];
  const traces: WorkflowDraftStepPreview[] = Array.isArray(latestPreview?.step_traces)
    ? latestPreview.step_traces
    : [];
  const traceById = new Map<string, WorkflowDraftStepPreview>();
  for (const t of traces) traceById.set(t.step_id, t);

  const stepIds = new Set<string>();
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
   * Transitive probe-evidence exemption — identical contract to
   * `loop-authoring-gate.ts#transitivelyExempt`. A request step routed
   * through a probed connector counts as shape evidence; an
   * intermediate transform that reads from such a request is also
   * exempt, since the chain ultimately rests on the same probe.
   * Depth-bounded to 16 to prevent pathological recursion through
   * circular transform refs that earlier validators didn't catch.
   *
   * Connector binding is recognized in three forms:
   *   1. explicit `step.connector_slug` field
   *   2. `${connector.<slug>.*}` placeholders in any string leaf of
   *      the step config (URL, headers, body, query) — the
   *      reference-impl-style and legacy binding shape
   *   3. recursive walk through a `transform` step's expression
   */
  function transitivelyExempt(stepId: string, seen = new Set<string>()): boolean {
    if (seen.has(stepId) || seen.size > 16) return false;
    seen.add(stepId);
    const s = stepById.get(stepId);
    if (!s) return false;
    if (typeof s.connector_slug === "string" && probedSlugs.has(s.connector_slug as string)) {
      return true;
    }
    // Placeholder-based binding: scan the step for
    // `${connector.<slug>.*}` references and exempt when any matched
    // slug is in the probed set. Mirrors the binding shape
    // `collectProbedConnectorSlugs` picks up.
    try {
      const json = JSON.stringify(s);
      const re = /\$\{\s*connector\.([a-zA-Z][a-zA-Z0-9_-]*)\b/g;
      for (let m = re.exec(json); m !== null; m = re.exec(json)) {
        const slug = m[1];
        if (slug && probedSlugs.has(slug)) return true;
      }
    } catch {
      // step contained an un-stringifyable value — fall through to
      // the transform-chain check rather than failing closed here.
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
      // Probe-evidence exemption: when the referenced step is a
      // request through a probed connector — directly or transitively
      // through a chain of transforms — skip the gate. The probe IS
      // the shape evidence.
      if (transitivelyExempt(ref)) continue;
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
