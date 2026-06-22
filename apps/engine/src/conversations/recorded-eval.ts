// Recorded-evaluation pass for authoring mutations (Fix 9, session
// 784c1b02 post-mortem).
//
// `build_workflow` / `edit_workflow_patch` / `propose_step` run this
// pass server-side as part of the tool call and return its findings in
// the same result envelope — the loop/transform authoring gates become
// OUTCOMES the model reads, not preconditions that bounce the mutation.
// The model gets generate → evaluate → repair in one round trip instead
// of build → blocked → inspect → dry-run → rebuild (the 102-dry-run /
// 16× `loop_authoring_requires_inspect` thrash).
//
// What the pass does — all of it against RECORDED evidence, never a
// live call (`dry_run_workflow` stays the only explicit live step):
//
//   1. Compile every authored expression: JSONata with the engine's
//      caret-pointed errors (`jsonata-engine.ts#formatError`);
//      `language: "javascript"` bodies via a parse-only QuickJS check
//      (`js-transform-eval.ts` — same sandbox, zero egress, zero host
//      globals).
//   2. Scope-reference resolution against fingerprint-valid recorded
//      previews: every `$scope.<X>` cite is classified
//      recorded / stale / missing.
//   3. Transform / loop-over evaluation against the recorded
//      `scope_at_step` where evidence exists, with the same
//      empty-extraction path-candidate machinery the execution layer
//      uses (`enumerateScopePaths`).
//   4. The loop/transform authoring-gate verdicts.
//
// The repair stage (Fix 10) is wired into this seam: when the caller
// passes a repair context (tenant for budget accounting), findings of
// status `compile_error` / `empty_result` get a bounded (≤2 attempts)
// LLM repair pass and the outcome rides the finding as
// `repair: { repaired, expression, before, after, attempts }`.
// PROPOSE, don't apply — the draft is never mutated here; the model
// applies an accepted repair via a normal edit.

import { buildJsonataBindings } from "../execution/jsonata-bindings.ts";
import {
  compile as compileJsonata,
  formatError as formatJsonataError,
} from "../execution/jsonata-engine.ts";
import { logger } from "../logging/logger.ts";
import { recordAuthoringGateBlock } from "../observability/instrumentation.ts";
import { extractStepIdReferences } from "../workflows/levenshtein.ts";
import {
  type ReferenceValidationError,
  validateBareIterationIdentifiers,
} from "../workflows/reference-validator.ts";
import { enumerateScopePaths, summarizeScopeShape } from "../workflows/scope-shape.ts";
import {
  checkJsBodySyntax,
  evaluateJsBody,
  extractJsScopeReferences,
} from "./js-transform-eval.ts";
import { fingerprintsById } from "./step-fingerprint.ts";
import {
  describeLoopGateBlock,
  evaluateLoopAuthoringGate,
  type LoopGateBlock,
} from "./tools/loop-authoring-gate.ts";
import {
  describeTransformGateBlock,
  evaluateTransformAuthoringGate,
  isHandRolledCodecBlock,
  type TransformGateBlock,
} from "./tools/transform-authoring-gate.ts";
import { repairTransformExpression, type TransformRepairOutcome } from "./transform-repair.ts";
import type { DraftDocument, WorkflowDraftStepPreview } from "./types.ts";

/** Per-evaluation wall-clock cap. Recorded evaluation must never make a
 *  tool call feel like a dry-run; a pathological expression times out
 *  as an `eval_error` finding instead of stalling the envelope. */
const EVAL_TIMEOUT_MS = 500;
/** Inline `value_preview` budget — larger results collapse to a shape
 *  summary so the envelope stays cheap. */
const VALUE_PREVIEW_MAX_CHARS = 500;
const PATH_CANDIDATES_PER_REF = 8;
const PATH_CANDIDATES_MAX = 12;

/**
 * Total number of per-site repair `invoke()` fan-outs allowed across a
 * SINGLE recorded-eval pass, regardless of how many findings the draft
 * carries. The bound is a property of the repair option, so every
 * caller that arms repair (the authoring pipeline, build_workflow,
 * propose_step, edit_workflow_patch) inherits it.
 *
 * Rationale (STALL root cause S2): a freshly-generated draft evaluated
 * against thin recorded evidence produces compile_error / empty_result
 * on most transform/loop sites. The old code ran a sequential `for`
 * loop over EVERY such finding, each firing up to MAX_REPAIR_ATTEMPTS
 * (2) untimed slow-model `invoke()`s — 6-10 findings × 2 = 12-20 serial
 * calls inside one tool execution, minutes of wall-clock even without a
 * hang. A draft that broken should be regenerated/edited by the
 * conversation model in ONE shot from the full findings list, not
 * auto-repaired site-by-site. So:
 *   - findings ≤ MAX_REPAIR_FINDINGS  → repair them (≤ this many sites).
 *   - findings >  MAX_REPAIR_FINDINGS → SKIP per-site repair entirely;
 *     ALL findings ride the result envelope for the model to fix.
 */
export const MAX_PIPELINE_REPAIRS = 3;
/** When the count of repairable findings exceeds this threshold the
 *  draft is "too broken to patch site-by-site" — skip repair and return
 *  every finding to the model. Kept equal to {@link MAX_PIPELINE_REPAIRS}
 *  so the only two regimes are "repair all (few)" or "repair none
 *  (many)" — never a confusing partial-repair-of-a-broken-draft. */
export const MAX_REPAIR_FINDINGS = MAX_PIPELINE_REPAIRS;

export interface RecordedEvalExpressionFinding {
  /** Dotted site, e.g. `steps.shape.expression`, `steps.iter.over`,
   *  `output_transform`. */
  site: string;
  step_id: string | null;
  status: "ok" | "compile_error" | "eval_error" | "empty_result" | "not_evaluated";
  /** Caret-pointed engine error for compile_error / eval_error; a
   *  human hint for empty_result / not_evaluated. */
  message?: string;
  position?: number;
  /** Small inline result (or a shape summary string for big ones) when
   *  the expression evaluated against recorded scope. */
  value_preview?: unknown;
  /** Copy-paste `$scope.<id>.data.<path>` candidates when an evaluated
   *  expression produced an empty result over non-empty evidence. */
  path_candidates?: string[];
  /** Set when an `empty_result` was produced while the recorded evidence
   *  for a referenced step was TRUNCATED (offloaded payload / `[omitted: …]`
   *  stub / sampling marker). An empty result over truncated evidence is
   *  NOT a confirmed problem — the path may be correct but the data was
   *  stubbed out — so it does NOT block the commit gate or the judge. This
   *  is the dry-run-vs-runtime divergence behind the Gmail session: the
   *  preview showed `[]` while the live run returned 174. */
  against_truncated_evidence?: boolean;
  /** Bounded auto-repair outcome (Fix 10), present when the caller
   *  enabled repair and this finding was `compile_error` /
   *  `empty_result`. PROPOSE-only: the draft is NOT mutated — apply
   *  the `expression` via update_param / edit_workflow_patch. */
  repair?: TransformRepairOutcome;
}

export interface RecordedEvalScopeRef {
  site: string;
  step_id: string | null;
  referenced_step_id: string;
  /** Evidence state for the referenced step, fingerprint-checked. */
  evidence: "recorded" | "stale" | "missing";
}

export interface RecordedEvalMissingEvidence {
  step_id: string;
  reason: string;
  // `dry_run_workflow` for preview-evidence gaps; `rewrite_with_sk_base64`
  // for a hand-rolled-codec block, where re-running fixes nothing (the
  // author must swap the alphabet literal for an `sk.*` encoder).
  next_action: "dry_run_workflow" | "rewrite_with_sk_base64";
}

export interface RecordedEvalReport {
  /** True when no compile/eval/empty findings and both gates pass. */
  ok: boolean;
  summary: string;
  expressions: RecordedEvalExpressionFinding[];
  scope_refs: RecordedEvalScopeRef[];
  gates: {
    loop: { ok: boolean; blocks: LoopGateBlock[] };
    transform: { ok: boolean; blocks: TransformGateBlock[] };
  };
  /** Exactly which steps need a recorded preview before the draft can
   *  preview/commit cleanly — the evidence the old gate refusals only
   *  implied. */
  missing_evidence: RecordedEvalMissingEvidence[];
  /** Ordered, deduplicated tool names the model should reach for. */
  next_actions: string[];
  /** Set when repair was armed but the draft carried more repairable
   *  findings than `MAX_REPAIR_FINDINGS`, so per-site auto-repair was
   *  skipped and ALL findings are returned for the model to fix in one
   *  shot (regenerate / edit) rather than serial site-by-site repair.
   *  Carries the finding count so the envelope explains the skip. */
  repair_skipped?: { reason: "too_many_findings"; finding_count: number; threshold: number };
}

export interface RecordedEvalEvidence {
  /** The draft's persisted preview slot — fingerprint-keyed traces. */
  latest_preview: DraftDocument["latest_preview"] | null;
  /** Optional richer scope from the per-conversation last-preview
   *  store (untruncated, envelope-shaped). Entries are only consulted
   *  for steps whose trace is fingerprint-valid. */
  scope?: Record<string, unknown> | null;
  /** Workflow input recorded with the preview, bound as `$input`. */
  input?: unknown;
  /** Probe-evidence exemption set, same contract as the gates. */
  probedConnectorSlugs?: ReadonlySet<string>;
}

/** Caller-supplied context enabling the bounded repair stage (Fix 10).
 *  Without it the pass stays pure compute — no LLM call is ever made. */
export interface RecordedEvalRepairContext {
  tenant_id: string;
  /** DB executor passed through to `invoke()` for route resolution +
   *  token-budget accounting. */
  db?: Parameters<typeof repairTransformExpression>[0]["db"];
  /** Optional pipeline/turn deadline signal, threaded into every repair
   *  `invoke()` so the fan-out is bounded by one shared clock and a
   *  deadline hit aborts the remaining repairs (P2). */
  signal?: AbortSignal;
}

export interface RecordedEvalOptions {
  repair?: RecordedEvalRepairContext;
}

interface WorkflowLike {
  steps: ReadonlyArray<Record<string, unknown>>;
  output_transform?: string;
}

export interface ExpressionSite {
  site: string;
  step_id: string | null;
  /** Authored expression language at this site. `when` / `over` /
   *  `output_transform` are always JSONata; transform steps carry
   *  whichever the author chose. */
  language: "jsonata" | "javascript";
  expression: string;
  /** Whether the recorded-eval pass may EVALUATE (not just compile)
   *  this site against recorded scope. */
  evaluable: boolean;
}

function collectControlFlowChildIds(steps: ReadonlyArray<Record<string, unknown>>): Set<string> {
  const childIds = new Set<string>();
  const collect = (arr: unknown): void => {
    if (!Array.isArray(arr)) return;
    for (const child of arr) if (typeof child === "string") childIds.add(child);
  };
  for (const step of steps) {
    const kind = step.kind;
    if (kind !== "loop" && kind !== "branch" && kind !== "parallel") continue;
    collect((step as { body?: unknown }).body);
    collect((step as { then_steps?: unknown }).then_steps);
    collect((step as { else_steps?: unknown }).else_steps);
    const branches = (step as { branches?: unknown }).branches;
    if (Array.isArray(branches)) for (const br of branches) collect(br);
  }
  return childIds;
}

function collectExpressionSites(workflow: WorkflowLike): ExpressionSite[] {
  const sites: ExpressionSite[] = [];
  const controlFlowChildren = collectControlFlowChildIds(workflow.steps);
  for (const step of workflow.steps) {
    const id = typeof step.id === "string" ? step.id : null;
    if (!id) continue;
    const kind = typeof step.kind === "string" ? step.kind : "";
    // A step inside a loop body / branch arm runs with `$item` /
    // `item_var` context the recorded scope cannot supply — compile
    // only, never evaluate.
    const inControlFlowBody = controlFlowChildren.has(id);
    if (kind === "transform") {
      // Transforms are JavaScript-only; an unset language means JS (mirrors
      // the runtime executor). The web-scraper languages carry no expression
      // and are excluded by the `expression` guard below.
      const language = typeof step.language === "string" ? step.language : "javascript";
      if (
        (language === "jsonata" || language === "javascript") &&
        typeof step.expression === "string" &&
        step.expression
      ) {
        sites.push({
          site: `steps.${id}.expression`,
          step_id: id,
          language,
          expression: step.expression,
          evaluable: !inControlFlowBody,
        });
      }
    }
    if (kind === "branch" && typeof step.when === "string" && step.when) {
      sites.push({
        site: `steps.${id}.when`,
        step_id: id,
        language: "jsonata",
        expression: step.when,
        evaluable: false,
      });
    }
    if (kind === "loop" && typeof step.over === "string" && step.over) {
      sites.push({
        site: `steps.${id}.over`,
        step_id: id,
        language: "jsonata",
        expression: step.over,
        evaluable: !inControlFlowBody,
      });
    }
  }
  if (typeof workflow.output_transform === "string" && workflow.output_transform) {
    sites.push({
      site: "output_transform",
      step_id: null,
      language: "jsonata",
      expression: workflow.output_transform,
      evaluable: true,
    });
  }
  return sites;
}

/** Classify evidence for one step id against the fingerprint-checked
 *  trace map. */
function evidenceStateFor(
  ref: string,
  traceById: Map<string, WorkflowDraftStepPreview>,
  fingerprints: Map<string, string>,
): "recorded" | "stale" | "missing" {
  const trace = traceById.get(ref);
  if (!trace || trace.output_preview === undefined || trace.output_preview === null) {
    return "missing";
  }
  const currentFp = fingerprints.get(ref);
  if (typeof trace.fingerprint === "string" && currentFp && trace.fingerprint !== currentFp) {
    return "stale";
  }
  return "recorded";
}

async function evaluateWithTimeout(
  expression: string,
  root: unknown,
  bindings: Record<string, unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string; position?: number }> {
  let compiled: ReturnType<typeof compileJsonata>;
  try {
    compiled = compileJsonata(expression);
  } catch (err) {
    const e = formatJsonataError(err, expression);
    return {
      ok: false,
      message: e.message,
      ...(e.position !== undefined ? { position: e.position } : {}),
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race<unknown>([
      compiled.evaluate(root, bindings).catch((err: unknown) => {
        throw formatJsonataError(err, expression);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`recorded evaluation exceeded ${EVAL_TIMEOUT_MS}ms`)),
          EVAL_TIMEOUT_MS,
        );
      }),
    ]);
    return { ok: true, value };
  } catch (err) {
    const e = err as { message?: string; position?: number };
    return {
      ok: false,
      message: typeof e.message === "string" ? e.message : String(err),
      ...(typeof e.position === "number" ? { position: e.position } : {}),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function previewValue(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined && json.length <= VALUE_PREVIEW_MAX_CHARS) return value;
  } catch {
    // fall through to the shape summary
  }
  return summarizeScopeShape(value);
}

function pathCandidatesFor(
  refs: ReadonlyArray<string>,
  recordedScope: Record<string, unknown>,
  /** Addressing root in the site's language: `$scope` (JSONata) or
   *  `input.scope` (JS function body). */
  prefix: "$scope" | "input.scope" = "$scope",
): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    const env = recordedScope[ref] as { data?: unknown } | undefined;
    const payload = env?.data;
    if (payload === null || payload === undefined) continue;
    const rels = enumerateScopePaths(payload, { path_budget: 60 }).filter(
      (rel) => !/\[\d+\]|\[\*\]/.test(rel),
    );
    rels.sort((a, b) => a.length - b.length);
    for (const rel of rels.slice(0, PATH_CANDIDATES_PER_REF)) {
      out.push(rel ? `${prefix}.${ref}.data.${rel}` : `${prefix}.${ref}.data`);
    }
  }
  return out.slice(0, PATH_CANDIDATES_MAX);
}

/** Step ids a site references, in the site's own language. */
function referencedStepIds(site: ExpressionSite, stepIds: ReadonlySet<string>): string[] {
  const raw =
    site.language === "javascript"
      ? extractJsScopeReferences(site.expression)
      : extractStepIdReferences(site.expression);
  return raw.filter((ref) => stepIds.has(ref) && ref !== site.step_id);
}

/**
 * JSONata site evaluation — compile with caret errors, then (when
 * evaluable) evaluate against the recorded scope with the execution
 * bindings. Exported so the JSONata-specific authoring checks stay one
 * cohesive, testable branch.
 */
export async function evaluateJsonataSite(
  site: ExpressionSite,
  refs: ReadonlyArray<string>,
  evaluable: boolean,
  recordedScope: Record<string, unknown>,
  input: unknown,
  bareIterationLint: ReadonlyArray<ReferenceValidationError> = [],
): Promise<RecordedEvalExpressionFinding> {
  // (1) compile with caret errors.
  try {
    compileJsonata(site.expression);
  } catch (err) {
    const e = formatJsonataError(err, site.expression);
    return {
      site: site.site,
      step_id: site.step_id,
      status: "compile_error",
      message: e.message,
      ...(e.position !== undefined ? { position: e.position } : {}),
    };
  }

  // (1b) bare-iteration-identifier lint (item_var retirement). The
  // expression COMPILES — bare `item` is a valid JSONata path — but
  // the runtime binds the current loop item as `$item` only, so the
  // reference resolves to nothing at execution time. Reported with the
  // same status the genuine runtime failure would surface as
  // (`eval_error`: ok=false, next_actions → update_param /
  // edit_workflow_patch, no LLM repair pass — the proven `$item`
  // rewrite from the AST rewriter IS the fix, carried in the message
  // and as a copy-paste `path_candidates` entry). The lint hits are
  // resolved by the caller against the full steps array (the enclosing
  // loop's declared/undeclared item_var state lives there); loop-body
  // sites only.
  if (bareIterationLint.length > 0) {
    const names = [...new Set(bareIterationLint.map((l) => l.bad_reference))]
      .map((n) => `\`${n}\``)
      .join(", ");
    const rewrites = [
      ...new Set(
        bareIterationLint
          .map((l) => l.did_you_mean[0])
          .filter((r): r is string => typeof r === "string" && r.length > 0 && r !== "$item"),
      ),
    ];
    return {
      site: site.site,
      step_id: site.step_id,
      status: "eval_error",
      message:
        `loop-body JSONata references the iteration item as bare ${names} — the runtime binds the current item as \`$item\` only` +
        (rewrites[0] !== undefined ? `; did you mean: \`${rewrites[0]}\`` : ""),
      ...(rewrites.length > 0 ? { path_candidates: rewrites } : {}),
    };
  }

  // (3) evaluation against recorded scope — only when every sibling
  // reference has recorded (fingerprint-valid) evidence. Sites with
  // no sibling refs (pure `$input` shapes) and sites inside loop
  // bodies are compile-only.
  if (!evaluable) {
    return {
      site: site.site,
      step_id: site.step_id,
      status: "not_evaluated",
      message:
        refs.length === 0
          ? "no sibling $scope references — compile check only"
          : "referenced step(s) have no fingerprint-valid recorded preview — run dry_run_workflow to record evidence",
    };
  }
  const bindings = buildJsonataBindings(recordedScope, input);
  const outcome = await evaluateWithTimeout(site.expression, recordedScope, bindings);
  if (!outcome.ok) {
    return {
      site: site.site,
      step_id: site.step_id,
      status: "eval_error",
      message: outcome.message,
      ...(outcome.position !== undefined ? { position: outcome.position } : {}),
    };
  }
  if (isEmptyEvalResult(outcome.value)) {
    const truncated = refsHaveTruncatedEvidence(refs, recordedScope);
    const candidates = pathCandidatesFor(refs, recordedScope);
    return {
      site: site.site,
      step_id: site.step_id,
      status: "empty_result",
      message: truncated
        ? EMPTY_AGAINST_TRUNCATED_MESSAGE
        : "expression evaluated to an empty result against the recorded scope — either the JSONata path is wrong, or a filter matched no rows",
      ...(truncated ? { against_truncated_evidence: true } : {}),
      ...(candidates.length > 0 ? { path_candidates: candidates } : {}),
    };
  }
  return {
    site: site.site,
    step_id: site.step_id,
    status: "ok",
    value_preview: previewValue(outcome.value),
  };
}

/**
 * JS site evaluation — same finding contract, QuickJS sandbox instead
 * of the JSONata engine. Non-evaluable sites get a parse-only syntax
 * check (the body is never executed); evaluable sites run for real
 * against the production context shape `{ scope, input }` under a
 * tight wall clock. Zero egress either way — QuickJS has no host
 * globals.
 */
async function evaluateJavascriptSite(
  site: ExpressionSite,
  refs: ReadonlyArray<string>,
  evaluable: boolean,
  recordedScope: Record<string, unknown>,
  input: unknown,
): Promise<RecordedEvalExpressionFinding> {
  if (!evaluable) {
    const syntax = await checkJsBodySyntax(site.expression);
    if (!syntax.ok) {
      return {
        site: site.site,
        step_id: site.step_id,
        status: "compile_error",
        message: syntax.message,
      };
    }
    return {
      site: site.site,
      step_id: site.step_id,
      status: "not_evaluated",
      message:
        refs.length === 0
          ? "no input.scope references — syntax check only"
          : "referenced step(s) have no fingerprint-valid recorded preview — run dry_run_workflow to record evidence",
    };
  }
  const outcome = await evaluateJsBody({ code: site.expression, scope: recordedScope, input });
  if (!outcome.ok) {
    return {
      site: site.site,
      step_id: site.step_id,
      status: outcome.kind,
      message: outcome.message,
    };
  }
  if (isEmptyEvalResult(outcome.value)) {
    const truncated = refsHaveTruncatedEvidence(refs, recordedScope);
    const candidates = pathCandidatesFor(refs, recordedScope, "input.scope");
    return {
      site: site.site,
      step_id: site.step_id,
      status: "empty_result",
      message: truncated
        ? EMPTY_AGAINST_TRUNCATED_MESSAGE
        : "function body returned an empty result against the recorded scope — either the input.scope.<step_id>.data path is wrong, or a filter matched no rows",
      ...(truncated ? { against_truncated_evidence: true } : {}),
      ...(candidates.length > 0 ? { path_candidates: candidates } : {}),
    };
  }
  return {
    site: site.site,
    step_id: site.step_id,
    status: "ok",
    value_preview: previewValue(outcome.value),
  };
}

function isEmptyEvalResult(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

// Deep-scan a recorded value for any marker that means "this is not the
// full payload": an in-memory OffloadRef, a truncate omission stub
// (`[omitted: … get_raw_result(…)]`), or a sampling/clip marker
// (`_truncated`, `_truncation_note`, `… sampled N of M items`, `+N more
// items`). Bounded depth so a pathological value can't stall the pass.
const OMISSION_STRING_RE = /^\[omitted: |… sampled \d+ of \d+|^\+\d+ more items/;
function valueContainsOmission(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === "string") return OMISSION_STRING_RE.test(value);
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) {
    for (const v of value) if (valueContainsOmission(v, depth + 1)) return true;
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (obj.$offloaded === true) return true;
  if ("_truncated" in obj || "_truncation_note" in obj) return true;
  for (const v of Object.values(obj)) if (valueContainsOmission(v, depth + 1)) return true;
  return false;
}

// True when the recorded evidence for ANY referenced step is truncated —
// so an empty evaluation result against it is unreliable (the path may be
// correct, the data just isn't all there).
function refsHaveTruncatedEvidence(
  refs: ReadonlyArray<string>,
  recordedScope: Record<string, unknown>,
): boolean {
  return refs.some((ref) => valueContainsOmission(recordedScope[ref]));
}

const EMPTY_AGAINST_TRUNCATED_MESSAGE =
  "function body returned an empty result, BUT it evaluated against TRUNCATED recorded evidence " +
  "(an upstream step's payload was offloaded/omitted in the preview). This is NOT a confirmed " +
  "problem — the path may be correct and the data simply wasn't all present. Re-run dry_run_workflow " +
  "for a faithful check, or call get_raw_result on the referenced step to inspect the full shape.";

/**
 * Run the recorded-evaluation pass over a candidate workflow draft.
 *
 * Compile + evaluation against recorded evidence only — JSONata via
 * the engine's compiler, `language: "javascript"` bodies via the
 * QuickJS sandbox (no host globals). No live HTTP, ever — side-effect
 * safety is the whole point (`dry_run_workflow` stays the explicit
 * live step). Without
 * `options.repair` the pass is pure compute; with it, findings of
 * status `compile_error` / `empty_result` additionally get a bounded
 * (≤2 attempts) LLM repair whose outcome rides the finding as
 * `repair` — propose-only, the draft is never mutated.
 */
export async function runRecordedEval(
  workflow: WorkflowLike,
  evidence: RecordedEvalEvidence,
  options: RecordedEvalOptions = {},
): Promise<RecordedEvalReport> {
  const steps = workflow.steps;
  const stepIds = new Set<string>();
  for (const step of steps) {
    if (typeof step.id === "string") stepIds.add(step.id);
  }
  const fingerprints = fingerprintsById(steps);
  const traces = evidence.latest_preview?.step_traces ?? [];
  const traceById = new Map<string, WorkflowDraftStepPreview>();
  for (const t of traces) traceById.set(t.step_id, t);

  // Recorded scope: envelope-shaped (`{ data: … }`) entries for every
  // step with fingerprint-valid evidence — identical addressing to the
  // execution scope (`$scope.<id>.data`). The richer last-preview-store
  // scope wins when present (untruncated), still gated on the trace's
  // fingerprint validity.
  const recordedScope: Record<string, unknown> = {};
  for (const [id, trace] of traceById) {
    if (!stepIds.has(id)) continue;
    if (evidenceStateFor(id, traceById, fingerprints) !== "recorded") continue;
    const stored = evidence.scope?.[id];
    recordedScope[id] =
      stored !== undefined && stored !== null ? stored : { data: trace.output_preview };
  }

  const sites = collectExpressionSites(workflow);
  const expressions: RecordedEvalExpressionFinding[] = [];
  const scope_refs: RecordedEvalScopeRef[] = [];

  // Bare-iteration-identifier lint (item_var retirement), resolved
  // once against the full steps array — the lint needs each site's
  // enclosing loop (declared/undeclared item_var) which a single
  // ExpressionSite cannot carry. Same pass the workflow validator and
  // the conversations verifier run; keyed by the site naming this
  // report already uses (`steps.<id>.<field>`). Loop-body JSONata
  // sites only by construction.
  const bareIterationBySite = new Map<string, ReferenceValidationError[]>();
  for (const lint of validateBareIterationIdentifiers(steps)) {
    const key = `steps.${lint.step_id}.${lint.field}`;
    const list = bareIterationBySite.get(key);
    if (list) list.push(lint);
    else bareIterationBySite.set(key, [lint]);
  }

  for (const site of sites) {
    // (2) scope-reference resolution against fingerprint-valid
    // recorded previews — reported per cite regardless of whether the
    // expression compiles. References are extracted in the site's own
    // language (`$scope.<id>` vs `input.scope.<id>`).
    const refs = referencedStepIds(site, stepIds);
    for (const ref of refs) {
      scope_refs.push({
        site: site.site,
        step_id: site.step_id,
        referenced_step_id: ref,
        evidence: evidenceStateFor(ref, traceById, fingerprints),
      });
    }

    // (1)+(3) compile, then evaluate against recorded scope — only
    // when every sibling reference has recorded (fingerprint-valid)
    // evidence. Sites with no sibling refs (pure `$input` shapes) and
    // sites inside loop bodies are compile-only. The language switch:
    // each branch owns its engine, its error formatting, and its
    // addressing vocabulary; the finding contract is shared.
    const evaluable =
      site.evaluable && refs.length > 0 && refs.every((ref) => ref in recordedScope);
    expressions.push(
      site.language === "javascript"
        ? await evaluateJavascriptSite(site, refs, evaluable, recordedScope, evidence.input ?? null)
        : await evaluateJsonataSite(
            site,
            refs,
            evaluable,
            recordedScope,
            evidence.input ?? null,
            bareIterationBySite.get(site.site) ?? [],
          ),
    );
  }

  // Bounded auto-repair (Fix 10, fan-out bound P2). For compile errors
  // and empty results over recorded evidence, run ≤MAX_REPAIR_ATTEMPTS
  // focused LLM attempts per finding and attach the verified outcome.
  // The draft is NOT touched — the model sees `repair.expression` in the
  // envelope and applies it via a normal edit.
  //
  // Fan-out bound (STALL S2): the total number of per-site repair
  // invokes is capped at MAX_PIPELINE_REPAIRS. If the draft carries MORE
  // than MAX_REPAIR_FINDINGS repairable findings it is too broken to
  // patch site-by-site — auto-repair is SKIPPED entirely and every
  // finding rides the envelope for the model to fix in one shot
  // (regenerate / edit), instead of serializing 12-20 untimed slow-model
  // calls inside a single tool execution. Each repair is also threaded
  // the optional deadline signal so the whole fan-out is bounded by one
  // shared clock; an aborted repair degrades to `{ repaired: false }`.
  const siteByName = new Map(sites.map((s) => [s.site, s] as const));
  let repair_skipped: RecordedEvalReport["repair_skipped"];
  if (options.repair) {
    const repairable = expressions.filter(
      (f): f is RecordedEvalExpressionFinding & { status: "compile_error" | "empty_result" } =>
        f.status === "compile_error" ||
        // Skip empties produced against truncated evidence — there is nothing
        // to repair (the path may be correct; the data was just offloaded).
        (f.status === "empty_result" && f.against_truncated_evidence !== true),
    );
    if (repairable.length > MAX_REPAIR_FINDINGS) {
      repair_skipped = {
        reason: "too_many_findings",
        finding_count: repairable.length,
        threshold: MAX_REPAIR_FINDINGS,
      };
      logger.info({
        module: "conversations",
        action: "recorded_eval.repair_skipped",
        msg: "draft carries more repairable findings than the per-pass cap — skipping site-by-site auto-repair, returning all findings to the model",
        tenant_id: options.repair.tenant_id,
        finding_count: repairable.length,
        threshold: MAX_REPAIR_FINDINGS,
      });
    } else {
      // The ≤ MAX_PIPELINE_REPAIRS resolvable sites repair concurrently.
      // Each `invoke()` is independent and mutates only its own finding;
      // every call threads the shared deadline `signal`, so a deadline
      // hit still aborts the whole fan-out — but the wall-clock is one
      // slow-model call, not the serial sum of three.
      const repairCtx = options.repair;
      const targets = repairable
        .map((finding) => ({ finding, site: siteByName.get(finding.site) }))
        .filter((t) => t.site !== undefined)
        .slice(0, MAX_PIPELINE_REPAIRS);
      await Promise.all(
        targets.map(async ({ finding, site }) => {
          const resolved = site!;
          const refs = referencedStepIds(resolved, stepIds);
          // `empty_result` findings only exist for sites that were
          // evaluated, so their refs are recorded by construction;
          // compile-error sites get the scope when it happens to exist.
          const hasRecordedScope = refs.length > 0 && refs.every((ref) => ref in recordedScope);
          finding.repair = await repairTransformExpression({
            expression: resolved.expression,
            language: resolved.language,
            finding: {
              kind: finding.status,
              message: finding.message ?? "",
              ...(finding.position !== undefined ? { position: finding.position } : {}),
            },
            scopeSample: hasRecordedScope ? recordedScope : null,
            input: evidence.input ?? null,
            pathCandidates: finding.path_candidates ?? [],
            site: finding.site,
            tenant_id: repairCtx.tenant_id,
            ...(repairCtx.db ? { db: repairCtx.db } : {}),
            ...(repairCtx.signal ? { signal: repairCtx.signal } : {}),
          });
        }),
      );
    }
  }

  // (4) gate verdicts — same evaluators, now reported instead of
  // enforced.
  const gateOptions = { probedConnectorSlugs: evidence.probedConnectorSlugs ?? new Set<string>() };
  const loopGate = evaluateLoopAuthoringGate(
    { steps },
    evidence.latest_preview ?? null,
    gateOptions,
  );
  const transformGate = evaluateTransformAuthoringGate(
    { steps },
    evidence.latest_preview ?? null,
    gateOptions,
  );

  const missingByStep = new Map<string, RecordedEvalMissingEvidence>();
  for (const b of loopGate.blocks) {
    missingByStep.set(b.referenced_step_id, {
      step_id: b.referenced_step_id,
      reason: describeLoopGateBlock(b),
      next_action: "dry_run_workflow",
    });
  }
  for (const b of transformGate.blocks) {
    // A hand-rolled-codec block is about the transform's own source, not an
    // upstream reference: key it on the transform step id, steer to a rewrite.
    const isCodec = isHandRolledCodecBlock(b);
    const key = isCodec ? b.transform_step_id : b.referenced_step_id;
    missingByStep.set(key, {
      step_id: key,
      reason: describeTransformGateBlock(b),
      next_action: isCodec ? "rewrite_with_sk_base64" : "dry_run_workflow",
    });
  }
  const missing_evidence = [...missingByStep.values()];

  const languageOf = (f: RecordedEvalExpressionFinding): "jsonata" | "javascript" =>
    siteByName.get(f.site)?.language ?? "javascript";
  const hasCompileErrors = expressions.some((f) => f.status === "compile_error");
  const hasEvalErrors = expressions.some((f) => f.status === "eval_error");
  // An empty result over TRUNCATED evidence is not a confirmed problem — the
  // payload was offloaded/omitted in the preview, so emptiness proves nothing.
  // It must not block the commit gate (the dry-run-vs-runtime divergence behind
  // the Gmail session). It still surfaces as a finding and points the author at
  // a faithful re-run, but only NON-truncated empties make `ok` false.
  const blockingEmptyResults = expressions.filter(
    (f) => f.status === "empty_result" && f.against_truncated_evidence !== true,
  );
  const hasEmptyResults = blockingEmptyResults.length > 0;
  const hasTruncatedEmptyResults = expressions.some(
    (f) => f.status === "empty_result" && f.against_truncated_evidence === true,
  );
  const hasJsonataEmptyResults = blockingEmptyResults.some((f) => languageOf(f) === "jsonata");
  const gatesOk = loopGate.ok && transformGate.ok;

  const repairedCount = expressions.filter((f) => f.repair?.repaired === true).length;

  const next_actions: string[] = [];
  // A verified repair proposal makes the targeted edit the obvious
  // first move regardless of which failure class produced it.
  if (repairedCount > 0) {
    next_actions.push("update_param", "edit_workflow_patch");
  }
  if (hasCompileErrors || hasEvalErrors) {
    next_actions.push("update_param", "edit_workflow_patch");
  }
  if (hasEmptyResults) {
    // `suggest_jsonata_paths` is a JSONata-path tool — JS empty results
    // already carry `input.scope.<id>.data` candidates on the finding.
    if (hasJsonataEmptyResults) next_actions.push("suggest_jsonata_paths");
    next_actions.push("dry_run_transform");
  }
  // Codec blocks resolve by an `sk.*` rewrite (steer to `update_param`); only
  // preview-evidence gaps want dry_run_workflow.
  const hasCodecBlock = transformGate.blocks.some(isHandRolledCodecBlock);
  const hasPreviewGap =
    !loopGate.ok || transformGate.blocks.some((b) => !isHandRolledCodecBlock(b));
  if (hasCodecBlock) {
    next_actions.push("update_param", "edit_workflow_patch");
  }
  // Truncated-evidence empties resolve with a faithful full-data run, not a
  // transform rewrite. A preview-gap missing_evidence entry also wants a run.
  const hasDryRunMissingEvidence = missing_evidence.some(
    (m) => m.next_action === "dry_run_workflow",
  );
  if (hasTruncatedEmptyResults || hasPreviewGap || hasDryRunMissingEvidence) {
    next_actions.push("dry_run_workflow");
  }

  const ok = !hasCompileErrors && !hasEvalErrors && !hasEmptyResults && gatesOk;
  const problems: string[] = [];
  if (hasCompileErrors) {
    const langs = new Set(
      expressions.filter((f) => f.status === "compile_error").map((f) => languageOf(f)),
    );
    problems.push(
      langs.size === 1 && langs.has("javascript")
        ? "JavaScript compile error(s)"
        : langs.size === 1
          ? "JSONata compile error(s)"
          : "expression compile error(s)",
    );
  }
  if (hasEvalErrors) problems.push("evaluation error(s) against recorded scope");
  if (hasEmptyResults) problems.push("empty result(s) over recorded evidence");
  if (!gatesOk) {
    const codecBlocks = transformGate.blocks.filter(isHandRolledCodecBlock);
    const previewBlocks =
      loopGate.blocks.length +
      transformGate.blocks.filter((b) => !isHandRolledCodecBlock(b)).length;
    if (previewBlocks > 0) {
      problems.push(
        `${previewBlocks} step(s) reference data with no recorded preview — run dry_run_workflow once to record the shape`,
      );
    }
    if (codecBlocks.length > 0) {
      problems.push(
        `${codecBlocks.length} transform step(s) hand-roll a codec alphabet/lookup table — rewrite with sk.base64Encode/base64UrlEncode/base64EncodeUtf8/base64Decode (or sk.hexEncode/hexDecode) via update_param`,
      );
    }
  }
  if (repairedCount > 0) {
    problems.push(
      `${repairedCount} verified repair proposal(s) attached (findings[].repair.expression) — the draft was NOT changed; apply via update_param / edit_workflow_patch`,
    );
  }
  if (repair_skipped) {
    problems.push(
      `${repair_skipped.finding_count} repairable findings exceed the per-pass auto-repair cap (${repair_skipped.threshold}) — site-by-site repair was skipped; the draft is too broken to patch piecemeal, regenerate or edit it in one pass from the full findings list`,
    );
  }
  const summary = ok
    ? "recorded evaluation passed: expressions compile and resolve against recorded evidence"
    : `recorded evaluation found: ${problems.join("; ")}`;

  return {
    ok,
    summary,
    expressions,
    scope_refs,
    gates: {
      loop: { ok: loopGate.ok, blocks: loopGate.blocks },
      transform: { ok: transformGate.ok, blocks: transformGate.blocks },
    },
    missing_evidence,
    next_actions: [...new Set(next_actions)],
    ...(repair_skipped ? { repair_skipped } : {}),
  };
}

/**
 * Observability for non-blocking gate verdicts. The
 * `authoring_gate_blocks_total` counter historically measured "the
 * gate fired"; it keeps doing so now that the firing is reported in
 * the envelope instead of refusing the call — operators tracking the
 * thrash class keep their signal. One warn log per failing pass
 * carries the per-finding detail for forensics.
 */
export function emitRecordedEvalSignals(args: {
  tool: string;
  conversation_id: string;
  report: RecordedEvalReport;
}): void {
  const { report } = args;
  if (!report.gates.loop.ok) {
    recordAuthoringGateBlock({ code: "loop_authoring_requires_inspect", tool: args.tool });
  }
  if (!report.gates.transform.ok) {
    // Split the metric by failure class: a hand-rolled-codec block is a
    // distinct authoring mistake from a missing-preview inspect gap.
    const hasCodec = report.gates.transform.blocks.some(isHandRolledCodecBlock);
    const hasInspect = report.gates.transform.blocks.some((b) => !isHandRolledCodecBlock(b));
    if (hasInspect) {
      recordAuthoringGateBlock({ code: "transform_authoring_requires_inspect", tool: args.tool });
    }
    if (hasCodec) {
      recordAuthoringGateBlock({ code: "transform_hand_rolled_codec", tool: args.tool });
    }
  }
  if (!report.ok) {
    logger.warn({
      module: "conversation_tool",
      action: "recorded_eval.findings",
      msg: `${args.tool} accepted the draft with recorded-eval findings`,
      conversation_id: args.conversation_id,
      tool: args.tool,
      summary: report.summary,
      compile_errors: report.expressions.filter((f) => f.status === "compile_error").length,
      eval_errors: report.expressions.filter((f) => f.status === "eval_error").length,
      empty_results: report.expressions.filter((f) => f.status === "empty_result").length,
      repairs_proposed: report.expressions.filter((f) => f.repair?.repaired === true).length,
      repairs_failed: report.expressions.filter((f) => f.repair?.repaired === false).length,
      loop_blocks: report.gates.loop.blocks.length,
      transform_blocks: report.gates.transform.blocks.length,
      missing_evidence: report.missing_evidence.map((m) => m.step_id),
    });
  }
}
