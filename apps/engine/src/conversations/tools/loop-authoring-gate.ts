import { extractStepIdReferences } from "../../workflows/levenshtein.ts";
import { stepFingerprint } from "../step-fingerprint.ts";
import type { DraftDocument, WorkflowDraftStepPreview } from "../types.ts";

export interface LoopGateBlock {
  loop_step_id: string;
  referenced_step_id: string;
  source: string;
  reason:
    | "no_preview_for_referenced_step"
    | "preview_missing_scope"
    | "no_dry_run_yet"
    | "preview_stale_for_referenced_step";
}

export function describeLoopGateBlock(b: LoopGateBlock): string {
  const why =
    b.reason === "no_dry_run_yet"
      ? "no dry-run has been recorded yet"
      : b.reason === "no_preview_for_referenced_step"
        ? `\`${b.referenced_step_id}\` has no recent preview`
        : b.reason === "preview_stale_for_referenced_step"
          ? `\`${b.referenced_step_id}\` changed since its preview was recorded (stale evidence)`
          : `the recorded preview for \`${b.referenced_step_id}\` doesn't include a scope summary`;
  return `loop \`${b.loop_step_id}\` reads \`$scope.${b.referenced_step_id}\` but ${why}`;
}

interface LoopGateResult {
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

interface LoopAuthoringGateOptions {
  probedConnectorSlugs?: ReadonlySet<string>;
}

export function evaluateLoopAuthoringGate(
  workflow: { steps: ReadonlyArray<Record<string, unknown>> },
  latestPreview: DraftDocument["latest_preview"],
  options: LoopAuthoringGateOptions = {},
): LoopGateResult {
  const blocks: LoopGateBlock[] = [];
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

  function transitivelyExempt(stepId: string, seen = new Set<string>()): boolean {
    if (seen.has(stepId) || seen.size > 16) return false;
    seen.add(stepId);
    const s = stepById.get(stepId);
    if (!s) return false;
    if (typeof s.connector_slug === "string" && probedSlugs.has(s.connector_slug as string)) {
      return true;
    }
    try {
      const json = JSON.stringify(s);
      const re = /\$\{\s*connector\.([a-zA-Z][a-zA-Z0-9_-]*)\b/g;
      for (let m = re.exec(json); m !== null; m = re.exec(json)) {
        const slug = m[1];
        if (slug && probedSlugs.has(slug)) return true;
      }
    } catch {}
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
      if (!stepIds.has(ref)) continue;
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
      const referencedStep = stepById.get(ref);
      if (
        typeof trace.fingerprint === "string" &&
        referencedStep &&
        trace.fingerprint !== stepFingerprint(referencedStep)
      ) {
        blocks.push({
          loop_step_id: step.id,
          referenced_step_id: ref,
          source: source.length > 200 ? `${source.slice(0, 200)}…` : source,
          reason: "preview_stale_for_referenced_step",
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
