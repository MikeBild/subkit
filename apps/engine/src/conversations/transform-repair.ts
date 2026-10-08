import { z } from "zod";
import type { Executor } from "../db/client.ts";
import { buildJsonataBindings } from "../execution/jsonata-bindings.ts";
import {
  compile as compileJsonata,
  describeUnknownFunction,
  findUnknownFunctionCalls,
  formatError as formatJsonataError,
} from "../execution/jsonata-engine.ts";
import { invoke } from "../llm/core/invoke.ts";
import { logger } from "../logging/logger.ts";
import { checkJsBodySyntax, evaluateJsBody } from "./js-transform-eval.ts";
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

export interface RepairTransformParams {
  expression: string;
  language?: TransformRepairLanguage;
  finding: TransformRepairFinding;
  scopeSample?: Record<string, unknown> | null;
  input?: unknown;
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

function renderScopeSample(scope: Record<string, unknown>): string {
  const bounded = truncateForLlm(scope, SCOPE_SAMPLE_CAP_CHARS);
  try {
    return JSON.stringify(bounded.data, null, 1) ?? "{}";
  } catch {
    return "(scope sample not serialisable)";
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
  if (params.scopeSample && Object.keys(params.scopeSample).length > 0) {
    const scopeHeading = javascript
      ? workflowOutput
        ? "Recorded upstream step outputs, for reference only — this body does NOT see them as `input.scope`; its `input` is the last step's `.data`:"
        : "Recorded upstream scope the body runs against (this object is `input.scope`; addressing: `input.scope.<step_id>.data`):"
      : workflowOutput
        ? "Recorded upstream step outputs (addressing: `$scope.<step_id>.data`):"
        : "Recorded upstream scope the expression evaluates against (root object; addressing: `$scope.<step_id>.data` — bare `<step_id>.data` also resolves):";
    lines.push("", scopeHeading, "```json", renderScopeSample(params.scopeSample), "```");
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
  );
  return lines.join("\n");
}

async function verifyCandidate(
  candidate: string,
  language: TransformRepairLanguage,
  finding: TransformRepairFinding,
  scope: Record<string, unknown> | null | undefined,
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (language === "javascript") {
    if (!scope || finding.kind === "compile_error") {
      const syntax = await checkJsBodySyntax(candidate);
      return syntax.ok ? { ok: true } : { ok: false, error: syntax.message };
    }
    const outcome = await evaluateJsBody({ code: candidate, scope, input: input ?? null });
    if (!outcome.ok) {
      return { ok: false, error: `candidate failed against recorded scope: ${outcome.message}` };
    }
    if (finding.kind === "empty_result" && isEmptyEvalResult(outcome.value)) {
      return {
        ok: false,
        error: "candidate ran but still returned an empty result against recorded scope",
      };
    }
    return { ok: true };
  }
  let compiled: ReturnType<typeof compileJsonata>;
  try {
    compiled = compileJsonata(candidate);
  } catch (err) {
    return { ok: false, error: formatJsonataError(err, candidate).message };
  }
  const [unknownFunction] = findUnknownFunctionCalls(candidate);
  if (unknownFunction) return { ok: false, error: describeUnknownFunction(unknownFunction) };
  if (!scope || finding.kind === "compile_error") return { ok: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race<unknown>([
      compiled.evaluate(scope, buildJsonataBindings(scope, input ?? null)).catch((err: unknown) => {
        throw formatJsonataError(err, candidate);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`verification exceeded ${VERIFY_EVAL_TIMEOUT_MS}ms`)),
          VERIFY_EVAL_TIMEOUT_MS,
        );
      }),
    ]);
    if (finding.kind === "empty_result" && isEmptyEvalResult(value)) {
      return {
        ok: false,
        error: "candidate compiled but still evaluated to an empty result against recorded scope",
      };
    }
    return { ok: true };
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
    return { ok: false, error: `candidate threw against recorded scope: ${msg}` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
      params.scopeSample,
      params.input,
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
