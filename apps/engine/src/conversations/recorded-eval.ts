import { z } from "@hono/zod-openapi";
import { buildJsonataBindings } from "../execution/jsonata-bindings.ts";
import {
  compile as compileJsonata,
  describeUnknownFunction,
  evaluate as evaluateJsonata,
  findUnknownFunctionCalls,
  formatError as formatJsonataError,
} from "../execution/jsonata-engine.ts";
import { logger } from "../logging/logger.ts";
import { recordAuthoringGateBlock } from "../observability/instrumentation.ts";
import { extractJsScopeReferences } from "../sandboxes/quickjs/scope-references.ts";
import { lintJsBody } from "../workflows/js-body-lint.ts";
import { extractStepIdReferences } from "../workflows/levenshtein.ts";
import {
  type ReferenceValidationError,
  validateBareIterationIdentifiers,
} from "../workflows/reference-validator.ts";
import { enumerateScopePaths, summarizeScopeShape } from "../workflows/scope-shape.ts";
import { checkJsBodySyntax, evaluateJsBody } from "./js-transform-eval.ts";
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
import {
  repairTransformExpression,
  type TransformEvaluation,
  type TransformRepairOutcome,
} from "./transform-repair.ts";
import type { DraftDocument, WorkflowDraftStepPreview } from "./types.ts";

const EVAL_TIMEOUT_MS = 500;
const VALUE_PREVIEW_MAX_CHARS = 500;
const PATH_CANDIDATES_PER_REF = 8;
const PATH_CANDIDATES_MAX = 12;

export const MAX_PIPELINE_REPAIRS = 3;
export const MAX_REPAIR_FINDINGS = MAX_PIPELINE_REPAIRS;

export interface RecordedEvalExpressionFinding {
  site: string;
  step_id: string | null;
  status: "ok" | "compile_error" | "eval_error" | "empty_result" | "not_evaluated";
  message?: string;
  position?: number;
  value_preview?: unknown;
  path_candidates?: string[];
  against_truncated_evidence?: boolean;
  repair?: TransformRepairOutcome;
}

export interface RecordedEvalScopeRef {
  site: string;
  step_id: string | null;
  referenced_step_id: string;
  evidence: "recorded" | "stale" | "missing";
}

export const MissingEvidenceNextActionSchema = z.enum([
  "dry_run_workflow",
  "rewrite_with_sk_base64",
]);

type MissingEvidenceNextAction = z.infer<typeof MissingEvidenceNextActionSchema>;

export const MISSING_EVIDENCE_NEXT_ACTIONS = {
  PREVIEW_GAP: "dry_run_workflow",
  CODEC_REWRITE: "rewrite_with_sk_base64",
} as const satisfies Record<string, MissingEvidenceNextAction>;

export const RecordedEvalMissingEvidenceSchema = z.object({
  step_id: z.string(),
  reason: z.string(),
  next_action: MissingEvidenceNextActionSchema,
});

export type RecordedEvalMissingEvidence = z.infer<typeof RecordedEvalMissingEvidenceSchema>;

export interface RecordedEvalReport {
  ok: boolean;
  summary: string;
  expressions: RecordedEvalExpressionFinding[];
  scope_refs: RecordedEvalScopeRef[];
  gates: {
    loop: { ok: boolean; blocks: LoopGateBlock[] };
    transform: { ok: boolean; blocks: TransformGateBlock[] };
  };
  missing_evidence: RecordedEvalMissingEvidence[];
  next_actions: string[];
  repair_skipped?: { reason: "too_many_findings"; finding_count: number; threshold: number };
}

interface RecordedEvalEvidence {
  latest_preview: DraftDocument["latest_preview"] | null;
  scope?: Record<string, unknown> | null;
  input?: unknown;
  probedConnectorSlugs?: ReadonlySet<string>;
}

interface RecordedEvalRepairContext {
  tenant_id: string;
  db?: Parameters<typeof repairTransformExpression>[0]["db"];
  signal?: AbortSignal;
}

interface RecordedEvalOptions {
  repair?: RecordedEvalRepairContext;
}

interface WorkflowLike {
  steps: ReadonlyArray<Record<string, unknown>>;
  output_transform?: string;
  output_schema?: Record<string, unknown>;
}

interface ExpressionSite {
  site: string;
  step_id: string | null;
  language: "jsonata" | "javascript";
  expression: string;
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

function recordedWorkflowOutputRoot(
  steps: ReadonlyArray<Record<string, unknown>>,
  recordedScope: Record<string, unknown>,
): { ok: true; root: unknown } | { ok: false } {
  const children = collectControlFlowChildIds(steps);
  for (let i = steps.length - 1; i >= 0; i--) {
    const id = steps[i]?.id;
    if (typeof id !== "string" || children.has(id)) continue;
    const envelope = recordedScope[id];
    if (!envelope || typeof envelope !== "object" || !("data" in envelope)) return { ok: false };
    return { ok: true, root: (envelope as { data: unknown }).data };
  }
  return { ok: false };
}

function collectExpressionSites(workflow: WorkflowLike): ExpressionSite[] {
  const sites: ExpressionSite[] = [];
  const controlFlowChildren = collectControlFlowChildIds(workflow.steps);
  for (const step of workflow.steps) {
    const id = typeof step.id === "string" ? step.id : null;
    if (!id) continue;
    const kind = typeof step.kind === "string" ? step.kind : "";
    const inControlFlowBody = controlFlowChildren.has(id);
    if (kind === "transform") {
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
  try {
    compileJsonata(expression);
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
      evaluateJsonata(expression, root, bindings),
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
  } catch {}
  return summarizeScopeShape(value);
}

function pathCandidatesFor(
  refs: ReadonlyArray<string>,
  recordedScope: Record<string, unknown>,
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

function referencedStepIds(site: ExpressionSite, stepIds: ReadonlySet<string>): string[] {
  const raw =
    site.language === "javascript"
      ? extractJsScopeReferences(site.expression)
      : extractStepIdReferences(site.expression);
  return raw.filter((ref) => stepIds.has(ref) && ref !== site.step_id);
}

export async function evaluateJsonataSite(
  site: ExpressionSite,
  refs: ReadonlyArray<string>,
  evaluable: boolean,
  recordedScope: Record<string, unknown>,
  input: unknown,
  bareIterationLint: ReadonlyArray<ReferenceValidationError> = [],
): Promise<RecordedEvalExpressionFinding> {
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
  const [unknownFunction] = findUnknownFunctionCalls(site.expression);
  if (unknownFunction) {
    return {
      site: site.site,
      step_id: site.step_id,
      status: "compile_error",
      message: describeUnknownFunction(unknownFunction),
      ...(unknownFunction.position !== undefined ? { position: unknownFunction.position } : {}),
    };
  }

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

async function evaluateJavascriptSite(
  site: ExpressionSite,
  refs: ReadonlyArray<string>,
  evaluable: boolean,
  recordedScope: Record<string, unknown>,
  input: unknown,
): Promise<RecordedEvalExpressionFinding> {
  const lint = lintJsBody(site.expression);
  if (lint.length > 0) {
    return {
      site: site.site,
      step_id: site.step_id,
      status: "compile_error",
      message: lint.map((f) => f.message).join(" "),
    };
  }
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

  const bareIterationBySite = new Map<string, ReferenceValidationError[]>();
  for (const lint of validateBareIterationIdentifiers(steps)) {
    const key = `steps.${lint.step_id}.${lint.field}`;
    const list = bareIterationBySite.get(key);
    if (list) list.push(lint);
    else bareIterationBySite.set(key, [lint]);
  }

  for (const site of sites) {
    const refs = referencedStepIds(site, stepIds);
    for (const ref of refs) {
      scope_refs.push({
        site: site.site,
        step_id: site.step_id,
        referenced_step_id: ref,
        evidence: evidenceStateFor(ref, traceById, fingerprints),
      });
    }

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

  const siteByName = new Map(sites.map((s) => [s.site, s] as const));
  let repair_skipped: RecordedEvalReport["repair_skipped"];
  if (options.repair) {
    const repairable = expressions.filter(
      (f): f is RecordedEvalExpressionFinding & { status: "compile_error" | "empty_result" } =>
        f.status === "compile_error" ||
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
      const repairCtx = options.repair;
      const targets = repairable
        .map((finding) => ({ finding, site: siteByName.get(finding.site) }))
        .filter((t) => t.site !== undefined)
        .slice(0, MAX_PIPELINE_REPAIRS);
      const outputRoot = recordedWorkflowOutputRoot(steps, recordedScope);
      await Promise.all(
        targets.map(async ({ finding, site }) => {
          const resolved = site!;
          const refs = referencedStepIds(resolved, stepIds);
          const hasRecordedScope = refs.length > 0 && refs.every((ref) => ref in recordedScope);
          const evaluation: TransformEvaluation | undefined =
            resolved.site === "output_transform"
              ? outputRoot.ok
                ? {
                    kind: "workflow_output",
                    root: outputRoot.root,
                    scope: recordedScope,
                    input: evidence.input ?? null,
                    output_schema: workflow.output_schema ?? null,
                  }
                : undefined
              : hasRecordedScope
                ? { kind: "step_scope", scope: recordedScope, input: evidence.input ?? null }
                : undefined;
          finding.repair = await repairTransformExpression({
            expression: resolved.expression,
            language: resolved.language,
            finding: {
              kind: finding.status,
              message: finding.message ?? "",
              ...(finding.position !== undefined ? { position: finding.position } : {}),
            },
            ...(evaluation ? { evaluation } : {}),
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
      next_action: MISSING_EVIDENCE_NEXT_ACTIONS.PREVIEW_GAP,
    });
  }
  for (const b of transformGate.blocks) {
    const isCodec = isHandRolledCodecBlock(b);
    const key = isCodec ? b.transform_step_id : b.referenced_step_id;
    missingByStep.set(key, {
      step_id: key,
      reason: describeTransformGateBlock(b),
      next_action: isCodec
        ? MISSING_EVIDENCE_NEXT_ACTIONS.CODEC_REWRITE
        : MISSING_EVIDENCE_NEXT_ACTIONS.PREVIEW_GAP,
    });
  }
  const missing_evidence = z
    .array(RecordedEvalMissingEvidenceSchema)
    .parse([...missingByStep.values()]);

  const languageOf = (f: RecordedEvalExpressionFinding): "jsonata" | "javascript" =>
    siteByName.get(f.site)?.language ?? "javascript";
  const hasCompileErrors = expressions.some((f) => f.status === "compile_error");
  const hasEvalErrors = expressions.some((f) => f.status === "eval_error");
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
  if (repairedCount > 0) {
    next_actions.push("edit_workflow_patch");
  }
  if (hasCompileErrors || hasEvalErrors) {
    next_actions.push("edit_workflow_patch");
  }
  if (hasEmptyResults) {
    if (hasJsonataEmptyResults) next_actions.push("suggest_jsonata_paths");
    next_actions.push("dry_run_transform");
  }
  const hasCodecBlock = transformGate.blocks.some(isHandRolledCodecBlock);
  const hasPreviewGap =
    !loopGate.ok || transformGate.blocks.some((b) => !isHandRolledCodecBlock(b));
  if (hasCodecBlock) {
    next_actions.push("edit_workflow_patch");
  }
  const hasDryRunMissingEvidence = missing_evidence.some(
    (m) => m.next_action === MISSING_EVIDENCE_NEXT_ACTIONS.PREVIEW_GAP,
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
        `${codecBlocks.length} transform step(s) hand-roll a codec alphabet/lookup table — rewrite with sk.base64Encode/base64UrlEncode/base64EncodeUtf8/base64Decode (or sk.hexEncode/hexDecode) via edit_workflow_patch`,
      );
    }
  }
  if (repairedCount > 0) {
    problems.push(
      `${repairedCount} verified repair proposal(s) attached (findings[].repair.expression) — the draft was NOT changed; apply via edit_workflow_patch`,
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
