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
import { extractJsScopeReferences } from "../js-transform-eval.ts";
import { traceFailedWithRuntimeDataError } from "../persistence/preview-failure-class.ts";
import { stepFingerprint } from "../step-fingerprint.ts";
import type { DraftDocument, WorkflowDraftStepPreview } from "../types.ts";

// A transform `expression` is JavaScript (`input.scope.<id>.data…`), while a
// `data_selector` is JSONata (`$scope.<id>…`). Collect upstream step-id
// references from whichever the step carries, in the right dialect, and union
// them. Before transforms became JavaScript-only this gate used the JSONata
// extractor for everything, so a JS transform that guessed an un-previewed
// sibling's shape slipped through ungated — exactly the failure the gate
// exists to block.
function extractTransformStepRefs(step: Record<string, unknown>): string[] {
  const out = new Set<string>();
  if (typeof step.expression === "string" && step.expression.length > 0) {
    for (const r of extractJsScopeReferences(step.expression)) out.add(r);
  }
  if (typeof step.data_selector === "string" && step.data_selector.length > 0) {
    for (const r of extractStepIdReferences(step.data_selector)) out.add(r);
  }
  return [...out];
}

export interface TransformGateBlock {
  /** id of the transform step that triggered the block. */
  transform_step_id: string;
  /** Upstream step id the transform's expression references. */
  referenced_step_id: string;
  /** Source expression text (truncated) so the LLM sees what it wrote. */
  expression: string;
  /** Why the gate refused — one of the enumerated reasons. */
  reason: "no_preview_for_referenced_step" | "no_dry_run_yet" | "preview_stale_for_referenced_step";
}

/** One-line human rendering of a block — single source for every tool
 *  that surfaces a transform-gate verdict (update_param's refusal
 *  message, the recorded-eval report on build/propose/patch). */
export function describeTransformGateBlock(b: TransformGateBlock): string {
  const why =
    b.reason === "no_dry_run_yet"
      ? "no dry-run has been recorded yet"
      : b.reason === "preview_stale_for_referenced_step"
        ? `\`${b.referenced_step_id}\` changed since its preview was recorded (stale evidence)`
        : `\`${b.referenced_step_id}\` has no recent preview`;
  return `transform \`${b.transform_step_id}\` reads \`$scope.${b.referenced_step_id}\` but ${why}`;
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

  // Control-flow exemption. A `loop`/`branch`/`parallel` step's output
  // shape is STRUCTURAL, not runtime-discoverable from a side-effect-free
  // dry-run, and its body/then/branch CHILD steps never record a
  // standalone `output_preview`:
  //   - a loop's children run inside the iteration and are marked
  //     `skipped` in the linear walk → no top-level trace
  //   - a 0-row loop never executes its body at all → no trace, ever
  //   - a branch's then/else steps don't run when the arm is not taken
  //     → no trace until the predicate happens to fire
  // Requiring a recorded preview for these is an UNSATISFIABLE gate: the
  // only way to record one is to run the side-effecting body (publish a
  // page, send an email), so authoring a post-loop summary transform
  // deadlocks against its own data. The shape a transform needs here is
  // the documented structural contract
  // (`$scope.<loop_id>.data.<body_step_id>.data` = array of per-iteration
  // body outputs), which the model authors from the schema, not from a
  // probe. So we exempt both the control-flow steps themselves and their
  // declared children from the preview requirement. The gate keeps its
  // teeth for the case it was built for: a transform guessing the
  // response shape of a plain `request`/`transform` sibling.
  const controlFlowStepIds = new Set<string>();
  const controlFlowChildIds = new Set<string>();
  for (const step of workflow.steps) {
    const kind = (step as { kind?: unknown }).kind;
    if (kind !== "loop" && kind !== "branch" && kind !== "parallel") continue;
    const id = (step as { id?: unknown }).id;
    if (typeof id === "string") controlFlowStepIds.add(id);
    const collect = (arr: unknown): void => {
      if (!Array.isArray(arr)) return;
      for (const child of arr) if (typeof child === "string") controlFlowChildIds.add(child);
    };
    // loop.body, branch.then_steps, branch.else_steps are string[]
    collect((step as { body?: unknown }).body);
    collect((step as { then_steps?: unknown }).then_steps);
    collect((step as { else_steps?: unknown }).else_steps);
    // parallel.branches is string[][]
    const branches = (step as { branches?: unknown }).branches;
    if (Array.isArray(branches)) for (const br of branches) collect(br);
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
    const upstream = extractTransformStepRefs(s);
    if (upstream.length === 0) return false;
    return upstream.some((u) => transitivelyExempt(u, seen));
  }

  for (const step of workflow.steps) {
    if (!isTransformStep(step)) continue;
    const expr = typeof step.expression === "string" ? step.expression : "";
    if (!expr) continue;
    const referenced = extractTransformStepRefs(step);
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
      // Control-flow exemption: loop/branch/parallel steps and their
      // body/then/branch children have no recordable standalone preview
      // (see the `controlFlowStepIds` comment above). Gating on them is
      // unsatisfiable without a side-effecting run, so exempt them — the
      // structural scope contract is what the transform reads here.
      if (controlFlowStepIds.has(ref) || controlFlowChildIds.has(ref)) continue;
      const trace = traceById.get(ref);
      // Runtime/data-failure exemption: a successful `build_workflow`
      // never records a runtime `output_preview`; only a dry_run does.
      // When the referenced step WAS dry-run but died on a runtime/data
      // error (404/410 on a deleted record, 401/403 on an un-granted
      // scope), its `output_preview` is never recorded and the gate
      // would fire forever. The draft itself is sound, so exempt it —
      // same spirit as the control-flow and probe-evidence exemptions.
      if (trace && traceFailedWithRuntimeDataError(trace)) continue;
      if (!trace || trace.output_preview === undefined || trace.output_preview === null) {
        blocks.push({
          transform_step_id: step.id,
          referenced_step_id: ref,
          expression: expr.length > 200 ? `${expr.slice(0, 200)}…` : expr,
          reason: traces.length === 0 ? "no_dry_run_yet" : "no_preview_for_referenced_step",
        });
        continue;
      }
      // Fingerprint-keyed evidence (Fix 5): a trace recorded against a
      // DIFFERENT definition of the referenced step is not evidence.
      // Mirrors the loop gate; traces without a fingerprint keep the
      // legacy trust (mutation-time pruning keeps those honest).
      const referencedStep = stepById.get(ref);
      if (
        typeof trace.fingerprint === "string" &&
        referencedStep &&
        trace.fingerprint !== stepFingerprint(referencedStep)
      ) {
        blocks.push({
          transform_step_id: step.id,
          referenced_step_id: ref,
          expression: expr.length > 200 ? `${expr.slice(0, 200)}…` : expr,
          reason: "preview_stale_for_referenced_step",
        });
      }
    }
  }
  return { ok: blocks.length === 0, blocks };
}
