import { z } from "zod";
import type { Executor } from "../db/client.ts";
import { buildJsonataBindings } from "../execution/jsonata-bindings.ts";
import {
  compile as compileJsonata,
  describeUnknownFunction,
  evaluate as evaluateJsonata,
  findUnknownFunctionCalls,
  flattenBindings,
  formatError as formatJsonataError,
} from "../execution/jsonata-engine.ts";
import { checkOutputContract, summarizeViolations } from "../execution/output-contract.ts";
import { invoke } from "../llm/core/invoke.ts";
import { logger } from "../logging/logger.ts";
import { lintJsBody } from "../workflows/js-body-lint.ts";
import {
  checkJsBodySyntax,
  evaluateJsBody,
  evaluateJsOutputFunction,
  type JsBodyEvalOutcome,
} from "./js-transform-eval.ts";
import { truncateForLlm } from "./tools/truncate.ts";

export const MAX_REPAIR_ATTEMPTS = 2;
const SCOPE_SAMPLE_CAP_CHARS = 2_000;
const VERIFY_EVAL_TIMEOUT_MS = 500;

export type TransformRepairFailureKind = "compile_error" | "eval_error" | "empty_result";

export type TransformRepairLanguage = "jsonata" | "javascript";

export interface TransformRepairFinding {
  kind: TransformRepairFailureKind;
  message: string;
  position?: number;
}

export type TransformEvaluation =
  | { kind: "step_scope"; scope: Record<string, unknown>; input: unknown }
  | {
      kind: "workflow_output";
      root: unknown;
      scope: Record<string, unknown>;
      input: unknown;
      output_schema: Record<string, unknown> | null;
    };

interface RepairTransformParams {
  expression: string;
  language?: TransformRepairLanguage;
  finding: TransformRepairFinding;
  evaluation?: TransformEvaluation;
  pathCandidates?: ReadonlyArray<string>;
  site?: string;
  tenant_id: string;
  db?: Executor;
  signal?: AbortSignal;
}

export type TransformRepairOutcome =
  | { repaired: true; expression: string; before: string; after: string; attempts: number }
  | { repaired: false; attempts: number; last_error: string };

const RepairProposalSchema = z.object({
  expression: z.string().min(1).max(10_000),
  reasoning: z.string().max(600).optional(),
});

function isEmptyEvalResult(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function renderSample(value: unknown): string {
  const bounded = truncateForLlm(value, SCOPE_SAMPLE_CAP_CHARS, { store: false });
  try {
    return JSON.stringify(bounded.data, null, 1) ?? "null";
  } catch {
    return "(sample not serialisable)";
  }
}

function buildRepairPrompt(params: RepairTransformParams, lastError: string): string {
  const javascript = params.language === "javascript";
  const workflowOutput =
    params.site === "output_transform" || params.site === "output_transform_function";
  const lines: string[] = javascript
    ? [
        workflowOutput
          ? "A JavaScript `output_transform_function` in a workflow draft failed. Propose a corrected function body that preserves the author's intent."
          : "A JavaScript transform in a workflow draft failed. Propose a corrected function body that preserves the author's intent.",
        "",
        "Execution contract (QuickJS sandbox, no host globals — no fetch, no process, no require, no network):",
        "- The code is a FUNCTION BODY (not a module, not an arrow function). It must `return` its result; a trailing expression also works.",
        ...(workflowOutput
          ? [
              "- It receives exactly one value, `input`: the workflow's final output — the last step's `.data`, exactly what the caller would receive without a transform.",
              "- There is NO `input.scope` and NO `input.input` here; upstream steps are not addressable from this body. Reshape what the output needs in the last step, then project it here.",
            ]
          : [
              "- It receives exactly one value, `input`:",
              "  - `input.scope.<step_id>.data` — recorded output of each upstream step",
              "  - `input.input` — the workflow input",
            ]),
        "",
        "Failed function body:",
        "```js",
        params.expression,
        "```",
        "",
        `Failure (${params.finding.kind}):`,
        lastError,
      ]
    : [
        workflowOutput
          ? "A JSONata `output_transform` in a workflow draft failed. Propose a corrected JSONata expression that preserves the author's intent."
          : "A JSONata expression in a workflow draft failed. Propose a corrected JSONata expression that preserves the author's intent.",
        ...(workflowOutput
          ? [
              "",
              "Evaluation contract:",
              "- The root value (`$`, bare paths) is the workflow's final output — the last step's `.data`.",
              "- Upstream steps are addressable as `$scope.<step_id>.data`, the workflow input as `$input`.",
            ]
          : []),
        "",
        "Failed expression:",
        "```",
        params.expression,
        "```",
        "",
        `Failure (${params.finding.kind}):`,
        lastError,
      ];
  const evaluation = params.evaluation;
  if (evaluation?.kind === "workflow_output") {
    lines.push(
      "",
      javascript
        ? "Recorded final value this body receives as `input` (the last step's `.data`):"
        : "Recorded final value the expression evaluates against (the root `$`, the last step's `.data`):",
      "```json",
      renderSample(evaluation.root),
      "```",
    );
    if (evaluation.output_schema) {
      lines.push(
        "",
        "Declared output_schema — the corrected result MUST satisfy it:",
        "```json",
        renderSample(evaluation.output_schema),
        "```",
      );
    }
  }
  if (evaluation && Object.keys(evaluation.scope).length > 0) {
    const scopeHeading = javascript
      ? workflowOutput
        ? "Recorded upstream step outputs, for reference only — this body does NOT see them as `input.scope`; its `input` is the last step's `.data`:"
        : "Recorded upstream scope the body runs against (this object is `input.scope`; addressing: `input.scope.<step_id>.data`):"
      : workflowOutput
        ? "Recorded upstream step outputs (addressing: `$scope.<step_id>.data`):"
        : "Recorded upstream scope the expression evaluates against (root object; addressing: `$scope.<step_id>.data` — bare `<step_id>.data` also resolves):";
    lines.push("", scopeHeading, "```json", renderSample(evaluation.scope), "```");
  }
  if (params.pathCandidates && params.pathCandidates.length > 0) {
    lines.push(
      "",
      "Known-good paths enumerated from the recorded evidence:",
      ...params.pathCandidates.map((p) => `- ${p}`),
    );
  }
  lines.push(
    "",
    "Rules:",
    javascript
      ? "- Return ONLY the corrected function body in the `expression` field — no `function` wrapper, no markdown fences."
      : "- Return ONLY the corrected expression in the `expression` field.",
    javascript
      ? "- Fix the path/logic/syntax problem; do not change what the code is trying to produce."
      : "- Fix the path/syntax problem; do not change what the expression is trying to produce.",
    ...(javascript
      ? []
      : [
          "- JSONata variables are `$`-prefixed; variable binding is `$name := value` inside a `( … )` block.",
          "- Only JSONata built-ins and functions bound with `$name := function($x) { … }` are callable — JSONata has NO JavaScript array/string methods (`$indexOf`, `$find`, `$includes`, `$slice`, `$toFixed` do not exist and throw at runtime).",
        ]),
    (javascript
      ? "- The corrected body must parse and run without throwing"
      : "- The corrected expression must compile") +
      (params.finding.kind === "empty_result"
        ? " AND produce a non-empty result against the recorded scope above."
        : "."),
    ...(evaluation?.kind === "workflow_output"
      ? [
          "- The corrected result must not be undefined against the recorded final value above" +
            (evaluation.output_schema ? " and must satisfy the declared output_schema." : "."),
        ]
      : []),
  );
  return lines.join("\n");
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race<T>([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`verification exceeded ${VERIFY_EVAL_TIMEOUT_MS}ms`)),
        VERIFY_EVAL_TIMEOUT_MS,
      );
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function describeThrown(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
}

function workflowOutputVerdict(
  value: unknown,
  finding: TransformRepairFinding,
  evaluation: Extract<TransformEvaluation, { kind: "workflow_output" }>,
): { ok: true } | { ok: false; error: string } {
  if (value === undefined) {
    return {
      ok: false,
      error:
        "candidate evaluated to undefined against the recorded final value — the engine would pass the raw output through unchanged",
    };
  }
  if (finding.kind === "empty_result" && isEmptyEvalResult(value)) {
    return {
      ok: false,
      error: "candidate ran but still produced an empty result against the recorded final value",
    };
  }
  if (evaluation.output_schema) {
    const contract = checkOutputContract(value, evaluation.output_schema);
    if (contract.ok && !contract.valid) {
      return {
        ok: false,
        error: `candidate result violates output_schema: ${summarizeViolations(contract.violations)}`,
      };
    }
  }
  return { ok: true };
}

async function verifyJavascriptCandidate(
  candidate: string,
  finding: TransformRepairFinding,
  evaluation: TransformEvaluation | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const lint = lintJsBody(candidate);
  if (lint.length > 0) {
    return { ok: false, error: lint.map((f) => f.message).join(" ") };
  }
  if (!evaluation || (evaluation.kind === "step_scope" && finding.kind === "compile_error")) {
    const syntax = await checkJsBodySyntax(candidate);
    return syntax.ok ? { ok: true } : { ok: false, error: syntax.message };
  }
  const outcome: JsBodyEvalOutcome =
    evaluation.kind === "workflow_output"
      ? await evaluateJsOutputFunction({ code: candidate, root: evaluation.root })
      : await evaluateJsBody({
          code: candidate,
          scope: evaluation.scope,
          input: evaluation.input ?? null,
        });
  if (!outcome.ok) {
    return {
      ok: false,
      error: `candidate failed against ${evaluation.kind === "workflow_output" ? "the recorded final value" : "recorded scope"}: ${outcome.message}`,
    };
  }
  if (evaluation.kind === "workflow_output") {
    return workflowOutputVerdict(outcome.value, finding, evaluation);
  }
  if (finding.kind === "empty_result" && isEmptyEvalResult(outcome.value)) {
    return {
      ok: false,
      error: "candidate ran but still returned an empty result against recorded scope",
    };
  }
  return { ok: true };
}

async function verifyJsonataCandidate(
  candidate: string,
  finding: TransformRepairFinding,
  evaluation: TransformEvaluation | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    compileJsonata(candidate);
  } catch (err) {
    return { ok: false, error: formatJsonataError(err, candidate).message };
  }
  const [unknownFunction] = findUnknownFunctionCalls(candidate);
  if (unknownFunction) return { ok: false, error: describeUnknownFunction(unknownFunction) };
  if (!evaluation) return { ok: true };
  if (evaluation.kind === "workflow_output") {
    try {
      const value = await withTimeout(
        evaluateJsonata(
          candidate,
          evaluation.root,
          flattenBindings({ input: evaluation.input ?? null, scope: evaluation.scope }),
        ),
      );
      return workflowOutputVerdict(value, finding, evaluation);
    } catch (err) {
      return {
        ok: false,
        error: `candidate threw against the recorded final value: ${describeThrown(err)}`,
      };
    }
  }
  if (finding.kind === "compile_error") return { ok: true };
  try {
    const value = await withTimeout(
      evaluateJsonata(
        candidate,
        evaluation.scope,
        buildJsonataBindings(evaluation.scope, evaluation.input ?? null),
      ),
    );
    if (finding.kind === "empty_result" && isEmptyEvalResult(value)) {
      return {
        ok: false,
        error: "candidate compiled but still evaluated to an empty result against recorded scope",
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `candidate threw against recorded scope: ${describeThrown(err)}` };
  }
}

function verifyCandidate(
  candidate: string,
  language: TransformRepairLanguage,
  finding: TransformRepairFinding,
  evaluation: TransformEvaluation | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return language === "javascript"
    ? verifyJavascriptCandidate(candidate, finding, evaluation)
    : verifyJsonataCandidate(candidate, finding, evaluation);
}

export async function repairTransformExpression(
  params: RepairTransformParams,
): Promise<TransformRepairOutcome> {
  let lastError = params.finding.message;
  const tried = new Set<string>([params.expression.trim()]);
  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    let candidate: string;
    try {
      const result = await invoke(
        {
          flow: "repair",
          tenant_id: params.tenant_id,
          user_turns: [{ role: "user", content: buildRepairPrompt(params, lastError) }],
          schema: RepairProposalSchema,
          ...(params.signal ? { signal: params.signal } : {}),
        },
        params.db,
      );
      const parsed = RepairProposalSchema.safeParse(result.object);
      if (!parsed.success) {
        lastError = "repair model returned no structured { expression } proposal";
        continue;
      }
      candidate = parsed.data.expression.trim();
    } catch (err) {
      lastError = `repair LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    if (tried.has(candidate)) {
      lastError = "repair model re-proposed an already-failed expression";
      continue;
    }
    tried.add(candidate);
    const verdict = await verifyCandidate(
      candidate,
      params.language ?? "javascript",
      params.finding,
      params.evaluation,
    );
    if (verdict.ok) {
      logger.info({
        module: "conversations",
        action: "transform_repair.repaired",
        msg: "bounded transform repair produced a verified candidate",
        tenant_id: params.tenant_id,
        site: params.site ?? null,
        language: params.language ?? "javascript",
        failure_kind: params.finding.kind,
        attempts: attempt,
      });
      return {
        repaired: true,
        expression: candidate,
        before: params.expression,
        after: candidate,
        attempts: attempt,
      };
    }
    lastError = verdict.error;
  }
  logger.info({
    module: "conversations",
    action: "transform_repair.gave_up",
    msg: "bounded transform repair exhausted its attempts",
    tenant_id: params.tenant_id,
    site: params.site ?? null,
    language: params.language ?? "javascript",
    failure_kind: params.finding.kind,
    attempts: MAX_REPAIR_ATTEMPTS,
    last_error: lastError,
  });
  return { repaired: false, attempts: MAX_REPAIR_ATTEMPTS, last_error: lastError };
}
