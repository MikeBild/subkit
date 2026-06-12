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
//   1. JSONata compile for every authored expression, with the engine's
//      caret-pointed errors (`jsonata-engine.ts#formatError`).
//   2. Scope-reference resolution against fingerprint-valid recorded
//      previews (Fix 5): every `$scope.<X>` cite is classified
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
import { enumerateScopePaths, summarizeScopeShape } from "../workflows/scope-shape.ts";
import { fingerprintsById } from "./step-fingerprint.ts";
import {
  describeLoopGateBlock,
  evaluateLoopAuthoringGate,
  type LoopGateBlock,
} from "./tools/loop-authoring-gate.ts";
import {
  describeTransformGateBlock,
  evaluateTransformAuthoringGate,
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
  next_action: "dry_run_workflow";
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
}

export interface RecordedEvalOptions {
  repair?: RecordedEvalRepairContext;
}

interface WorkflowLike {
  steps: ReadonlyArray<Record<string, unknown>>;
  output_transform?: string;
}

interface ExpressionSite {
  site: string;
  step_id: string | null;
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
      const language = typeof step.language === "string" ? step.language : "jsonata";
      if (language === "jsonata" && typeof step.expression === "string" && step.expression) {
        sites.push({
          site: `steps.${id}.expression`,
          step_id: id,
          expression: step.expression,
          evaluable: !inControlFlowBody,
        });
      }
    }
    if (kind === "branch" && typeof step.when === "string" && step.when) {
      sites.push({
        site: `steps.${id}.when`,
        step_id: id,
        expression: step.when,
        evaluable: false,
      });
    }
    if (kind === "loop" && typeof step.over === "string" && step.over) {
      sites.push({
        site: `steps.${id}.over`,
        step_id: id,
        expression: step.over,
        evaluable: !inControlFlowBody,
      });
    }
  }
  if (typeof workflow.output_transform === "string" && workflow.output_transform) {
    sites.push({
      site: "output_transform",
      step_id: null,
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
      out.push(rel ? `$scope.${ref}.data.${rel}` : `$scope.${ref}.data`);
    }
  }
  return out.slice(0, PATH_CANDIDATES_MAX);
}

function isEmptyEvalResult(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

/**
 * Run the recorded-evaluation pass over a candidate workflow draft.
 *
 * JSONata compile + evaluation against recorded evidence only. No live
 * HTTP, ever — side-effect safety is the whole point
 * (`dry_run_workflow` stays the explicit live step). Without
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

  for (const site of sites) {
    // (2) scope-reference resolution against fingerprint-valid
    // recorded previews — reported per cite regardless of whether the
    // expression compiles.
    const refs = extractStepIdReferences(site.expression).filter(
      (ref) => stepIds.has(ref) && ref !== site.step_id,
    );
    for (const ref of refs) {
      scope_refs.push({
        site: site.site,
        step_id: site.step_id,
        referenced_step_id: ref,
        evidence: evidenceStateFor(ref, traceById, fingerprints),
      });
    }

    // (1) compile with caret errors.
    try {
      compileJsonata(site.expression);
    } catch (err) {
      const e = formatJsonataError(err, site.expression);
      expressions.push({
        site: site.site,
        step_id: site.step_id,
        status: "compile_error",
        message: e.message,
        ...(e.position !== undefined ? { position: e.position } : {}),
      });
      continue;
    }

    // (3) evaluation against recorded scope — only when every sibling
    // reference has recorded (fingerprint-valid) evidence. Sites with
    // no sibling refs (pure `$input` shapes) and sites inside loop
    // bodies are compile-only.
    const evaluable =
      site.evaluable && refs.length > 0 && refs.every((ref) => ref in recordedScope);
    if (!evaluable) {
      expressions.push({
        site: site.site,
        step_id: site.step_id,
        status: "not_evaluated",
        message:
          refs.length === 0
            ? "no sibling $scope references — compile check only"
            : "referenced step(s) have no fingerprint-valid recorded preview — run dry_run_workflow to record evidence",
      });
      continue;
    }
    const bindings = buildJsonataBindings(recordedScope, evidence.input ?? null);
    const outcome = await evaluateWithTimeout(site.expression, recordedScope, bindings);
    if (!outcome.ok) {
      expressions.push({
        site: site.site,
        step_id: site.step_id,
        status: "eval_error",
        message: outcome.message,
        ...(outcome.position !== undefined ? { position: outcome.position } : {}),
      });
      continue;
    }
    if (isEmptyEvalResult(outcome.value)) {
      const candidates = pathCandidatesFor(refs, recordedScope);
      expressions.push({
        site: site.site,
        step_id: site.step_id,
        status: "empty_result",
        message:
          "expression evaluated to an empty result against the recorded scope — either the JSONata path is wrong, or a filter matched no rows",
        ...(candidates.length > 0 ? { path_candidates: candidates } : {}),
      });
      continue;
    }
    expressions.push({
      site: site.site,
      step_id: site.step_id,
      status: "ok",
      value_preview: previewValue(outcome.value),
    });
  }

  // Bounded auto-repair (Fix 10). For compile errors and empty results
  // over recorded evidence, run ≤2 focused LLM attempts per finding and
  // attach the verified outcome. The draft is NOT touched — the model
  // sees `repair.expression` in the envelope and applies it via a
  // normal edit. Repairs run sequentially: a draft rarely carries more
  // than a couple of broken expressions, and each repair is itself
  // budget-accounted through `invoke()`.
  if (options.repair) {
    const siteByName = new Map(sites.map((s) => [s.site, s] as const));
    for (const finding of expressions) {
      if (finding.status !== "compile_error" && finding.status !== "empty_result") continue;
      const site = siteByName.get(finding.site);
      if (!site) continue;
      const refs = extractStepIdReferences(site.expression).filter(
        (ref) => stepIds.has(ref) && ref !== site.step_id,
      );
      // `empty_result` findings only exist for sites that were
      // evaluated, so their refs are recorded by construction;
      // compile-error sites get the scope when it happens to exist.
      const hasRecordedScope = refs.length > 0 && refs.every((ref) => ref in recordedScope);
      finding.repair = await repairTransformExpression({
        expression: site.expression,
        finding: {
          kind: finding.status,
          message: finding.message ?? "",
          ...(finding.position !== undefined ? { position: finding.position } : {}),
        },
        scopeSample: hasRecordedScope ? recordedScope : null,
        input: evidence.input ?? null,
        pathCandidates: finding.path_candidates ?? [],
        site: finding.site,
        tenant_id: options.repair.tenant_id,
        ...(options.repair.db ? { db: options.repair.db } : {}),
      });
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
    missingByStep.set(b.referenced_step_id, {
      step_id: b.referenced_step_id,
      reason: describeTransformGateBlock(b),
      next_action: "dry_run_workflow",
    });
  }
  const missing_evidence = [...missingByStep.values()];

  const hasCompileErrors = expressions.some((f) => f.status === "compile_error");
  const hasEvalErrors = expressions.some((f) => f.status === "eval_error");
  const hasEmptyResults = expressions.some((f) => f.status === "empty_result");
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
    next_actions.push("suggest_jsonata_paths", "dry_run_transform");
  }
  if (!gatesOk || missing_evidence.length > 0) {
    next_actions.push("dry_run_workflow");
  }

  const ok = !hasCompileErrors && !hasEvalErrors && !hasEmptyResults && gatesOk;
  const problems: string[] = [];
  if (hasCompileErrors) problems.push("JSONata compile error(s)");
  if (hasEvalErrors) problems.push("evaluation error(s) against recorded scope");
  if (hasEmptyResults) problems.push("empty result(s) over recorded evidence");
  if (!gatesOk) {
    problems.push(
      `${loopGate.blocks.length + transformGate.blocks.length} step(s) reference data with no recorded preview — run dry_run_workflow once to record the shape`,
    );
  }
  if (repairedCount > 0) {
    problems.push(
      `${repairedCount} verified repair proposal(s) attached (findings[].repair.expression) — the draft was NOT changed; apply via update_param / edit_workflow_patch`,
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
    recordAuthoringGateBlock({ code: "transform_authoring_requires_inspect", tool: args.tool });
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
