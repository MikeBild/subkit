import { extractJsScopeReferences } from "../../sandboxes/quickjs/scope-references.ts";
import { extractStepIdReferences } from "../../workflows/levenshtein.ts";
import { traceFailedWithRuntimeDataError } from "../persistence/preview-failure-class.ts";
import { stepFingerprint } from "../step-fingerprint.ts";
import type { DraftDocument, WorkflowDraftStepPreview } from "../types.ts";

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

export type HandRolledCodecKind = "base64" | "base32" | "hex_table" | "reverse_lookup";

export interface TransformGateBlock {
  transform_step_id: string;
  referenced_step_id: string;
  expression: string;
  reason:
    | "no_preview_for_referenced_step"
    | "no_dry_run_yet"
    | "preview_stale_for_referenced_step"
    | "hand_rolled_codec_alphabet";
  codec_kind?: HandRolledCodecKind;
}

const HAND_ROLLED_B64_ALPHABET_RE: RegExp =
  /["'`](?=[^"'`]*ABCDEFGHIJKLMNOPQRSTUVWXYZ)(?=[^"'`]*abcdefghijklmnopqrstuvwxyz)(?=[^"'`]*0123456789)[A-Za-z0-9+/=_-]{40,}["'`]/;

const HAND_ROLLED_B32_ALPHABET_RE: RegExp = /ABCDEFGHIJKLMNOPQRSTUVWXYZ234567/;

const HAND_ROLLED_HEX_ALPHABET_RE: RegExp = /["'`]0123456789[aA][bB][cC][dD][eE][fF]["'`]/;

const REVERSE_LOOKUP_TABLE_RE: RegExp = /(?:["']?[A-Za-z0-9+/]["']?\s*:\s*\d+\s*,\s*){8,}/;

function normalizeAdjacentStringLiterals(src: string): string {
  const STR_CONCAT = /(['"`])((?:\\.|[^\\])*?)\1\s*\+\s*(['"`])((?:\\.|[^\\])*?)\3/g;
  let out = src;
  let prev: string;
  do {
    prev = out;
    out = out.replace(
      STR_CONCAT,
      (_m, q1: string, a: string, _q2: string, b: string) => `${q1}${a}${b}${q1}`,
    );
  } while (out !== prev);
  return out.replace(/\}\s*\+\s*\{/g, ",");
}

export function detectHandRolledCodec(expression: string): {
  found: boolean;
  kind: HandRolledCodecKind | null;
} {
  if (typeof expression !== "string" || expression.length === 0) {
    return { found: false, kind: null };
  }
  const src = normalizeAdjacentStringLiterals(expression);
  if (HAND_ROLLED_B64_ALPHABET_RE.test(src)) return { found: true, kind: "base64" };
  if (HAND_ROLLED_B32_ALPHABET_RE.test(src)) return { found: true, kind: "base32" };
  if (HAND_ROLLED_HEX_ALPHABET_RE.test(src)) return { found: true, kind: "hex_table" };
  if (REVERSE_LOOKUP_TABLE_RE.test(src)) return { found: true, kind: "reverse_lookup" };
  return { found: false, kind: null };
}

function skReplacementFor(kind: HandRolledCodecKind): string {
  switch (kind) {
    case "base64":
    case "base32":
    case "reverse_lookup":
      return "sk.base64Encode / sk.base64UrlEncode / sk.base64EncodeUtf8 / sk.base64Decode";
    case "hex_table":
      return "sk.hexEncode / sk.hexDecode";
  }
}

export function isHandRolledCodecBlock(b: TransformGateBlock): boolean {
  return b.reason === "hand_rolled_codec_alphabet";
}

export function describeTransformGateBlock(b: TransformGateBlock): string {
  if (b.reason === "hand_rolled_codec_alphabet") {
    const kind = b.codec_kind ?? "base64";
    return `transform \`${b.transform_step_id}\` hand-rolls a ${kind} codec alphabet/lookup table in its source; use ${skReplacementFor(kind)} instead — the sandbox ships deterministic encoders so an alphabet literal can never be corrupted into malformed output`;
  }
  const why =
    b.reason === "no_dry_run_yet"
      ? "no dry-run has been recorded yet"
      : b.reason === "preview_stale_for_referenced_step"
        ? `\`${b.referenced_step_id}\` changed since its preview was recorded (stale evidence)`
        : `\`${b.referenced_step_id}\` has no recent preview`;
  return `transform \`${b.transform_step_id}\` reads \`$scope.${b.referenced_step_id}\` but ${why}`;
}

interface TransformGateResult {
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

interface TransformAuthoringGateOptions {
  probedConnectorSlugs?: ReadonlySet<string>;
}

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

  const controlFlowStepIds = new Set<string>();
  const controlFlowChildIds = new Set<string>();
  for (const step of workflow.steps) {
    const kind = (step as { kind?: unknown }).kind;
    if (kind !== "branch" && kind !== "parallel") continue;
    const id = (step as { id?: unknown }).id;
    if (typeof id === "string") controlFlowStepIds.add(id);
    const collect = (arr: unknown): void => {
      if (!Array.isArray(arr)) return;
      for (const child of arr) if (typeof child === "string") controlFlowChildIds.add(child);
    };
    collect((step as { then_steps?: unknown }).then_steps);
    collect((step as { else_steps?: unknown }).else_steps);
    const branches = (step as { branches?: unknown }).branches;
    if (Array.isArray(branches)) for (const br of branches) collect(br);
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
    const upstream = extractTransformStepRefs(s);
    if (upstream.length === 0) return false;
    return upstream.some((u) => transitivelyExempt(u, seen));
  }

  for (const step of workflow.steps) {
    if (!isTransformStep(step)) continue;
    const expr = typeof step.expression === "string" ? step.expression : "";
    if (!expr) continue;
    const codec = detectHandRolledCodec(expr);
    if (codec.found && codec.kind) {
      blocks.push({
        transform_step_id: step.id,
        referenced_step_id: "",
        expression: expr.length > 200 ? `${expr.slice(0, 200)}…` : expr,
        reason: "hand_rolled_codec_alphabet",
        codec_kind: codec.kind,
      });
    }
    const referenced = extractTransformStepRefs(step);
    if (referenced.length === 0) continue;
    for (const ref of referenced) {
      if (!stepIds.has(ref)) continue;
      if (ref === step.id) continue;
      if (transitivelyExempt(ref)) continue;
      if (controlFlowStepIds.has(ref) || controlFlowChildIds.has(ref)) continue;
      const trace = traceById.get(ref);
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
