// Bounded transform auto-repair (Fix 10, sessions 2026-06-11/12
// post-mortem). Covers both authored transform languages: JSONata
// expressions and `language: "javascript"` function bodies.
//
// When an authored transform expression fails to compile, throws
// against recorded evidence, or evaluates to an empty result while the
// upstream data is non-empty, the engine runs a bounded repair: ≤2
// focused LLM calls, each fed the engine's error (caret-pointed for
// JSONata, the sandbox message for JS), a bounded sample of the
// recorded scope, path candidates in the language's own addressing
// (`$scope.<id>.data` / `input.scope.<id>.data`), and the failed
// expression. Every candidate is verified MECHANICALLY before it is
// accepted — compile via the engine's jsonata compiler or a parse-only
// QuickJS check, and (for failure classes with recorded evidence) a
// real evaluation against the recorded scope that must produce a
// non-empty value for the empty-result class.
//
// PROPOSE, don't apply — the self-healing discipline. The repair
// outcome rides the tool result (`repair: { repaired, expression,
// before, after, attempts }`); the draft is NEVER mutated here. The
// conversation model reads the repaired expression and applies it via
// a normal edit (`update_param` / `edit_workflow_patch`), so every
// applied repair is visible in the mutation history.
//
// Cost discipline: the call goes through `invoke()` (flow `repair`),
// which enforces the tenant's token budget and records usage like
// every other engine LLM call. Provider failures, quota exhaustion,
// and contract drift all degrade to `{ repaired: false, last_error }`
// — a repair must never make the surrounding tool call fail.

import { z } from "zod";

import type { Executor } from "../db/client.ts";
import { buildJsonataBindings } from "../execution/jsonata-bindings.ts";
import {
  compile as compileJsonata,
  formatError as formatJsonataError,
} from "../execution/jsonata-engine.ts";
import { invoke } from "../llm/core/invoke.ts";
import { logger } from "../logging/logger.ts";
import { checkJsBodySyntax, evaluateJsBody } from "./js-transform-eval.ts";
import { truncateForLlm } from "./tools/truncate.ts";

/** Hard attempt bound — the whole point of "bounded" repair. */
export const MAX_REPAIR_ATTEMPTS = 2;
/** Char budget for the recorded-scope sample embedded in the prompt. */
const SCOPE_SAMPLE_CAP_CHARS = 2_000;
/** Verification evaluation wall-clock cap — same bound the
 *  recorded-eval pass applies to authored expressions. */
const VERIFY_EVAL_TIMEOUT_MS = 500;

export type TransformRepairFailureKind = "compile_error" | "eval_error" | "empty_result";

export type TransformRepairLanguage = "jsonata" | "javascript";

export interface TransformRepairFinding {
  kind: TransformRepairFailureKind;
  /** Caret-pointed engine error (JSONata compile/eval), the QuickJS
   *  sandbox message (JS), or the empty-result hint produced by the
   *  recorded-eval pass. */
  message: string;
  position?: number;
}

export interface RepairTransformParams {
  /** The failed expression, verbatim. For `language: "javascript"`
   *  this is a function body (production `runJs` contract: one global
   *  `input`; data at `input.scope.<step_id>.data…`, workflow input at
   *  `input.input`; explicit `return`). */
  expression: string;
  /** Authored language of the failed expression. Transforms are
   *  JavaScript-only; default: javascript. (The `jsonata` member of the
   *  union remains for the one-line JSONata slots that may route here.) */
  language?: TransformRepairLanguage;
  finding: TransformRepairFinding;
  /** Envelope-shaped recorded scope (`$scope.<id>.data` addressing)
   *  the candidate is verified against. Required for the empty-result
   *  failure class — without recorded evidence a non-empty result
   *  cannot be proven, so candidates are compile-checked only. */
  scopeSample?: Record<string, unknown> | null;
  /** Workflow input recorded with the preview — bound as `$input`. */
  input?: unknown;
  /** Copy-paste path candidates from `enumerateScopePaths` over the
   *  recorded evidence, in the language's own addressing —
   *  `$scope.<id>.data.<path>` (JSONata) or
   *  `input.scope.<id>.data.<path>` (JS). */
  pathCandidates?: ReadonlyArray<string>;
  /** Dotted site for logging (`steps.shape.expression`, …). */
  site?: string;
  tenant_id: string;
  db?: Executor;
  /** Optional pipeline/turn deadline signal, threaded into the repair
   *  `invoke()` so an in-flight repair aborts the moment the enclosing
   *  pipeline's shared deadline fires (P2). When it aborts, `invoke()`
   *  throws a typed `LlmProviderError`, which is caught below and
   *  degrades to `{ repaired: false }` like any other provider failure. */
  signal?: AbortSignal;
}

export type TransformRepairOutcome =
  | { repaired: true; expression: string; before: string; after: string; attempts: number }
  | { repaired: false; attempts: number; last_error: string };

const RepairProposalSchema = z.object({
  /** The corrected expression (JSONata) or function body (JS) —
   *  nothing else. */
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
  const lines: string[] = javascript
    ? [
        "A JavaScript transform in a workflow draft failed. Propose a corrected function body that preserves the author's intent.",
        "",
        "Execution contract (QuickJS sandbox, no host globals — no fetch, no process, no require, no network):",
        "- The code is a FUNCTION BODY (not a module, not an arrow function). It must `return` its result; a trailing expression also works.",
        "- It receives exactly one value, `input`:",
        "  - `input.scope.<step_id>.data` — recorded output of each upstream step",
        "  - `input.input` — the workflow input",
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
        "A JSONata expression in a workflow draft failed. Propose a corrected JSONata expression that preserves the author's intent.",
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
    lines.push(
      "",
      javascript
        ? "Recorded upstream scope the body runs against (this object is `input.scope`; addressing: `input.scope.<step_id>.data`):"
        : "Recorded upstream scope the expression evaluates against (root object; addressing: `$scope.<step_id>.data` — bare `<step_id>.data` also resolves):",
      "```json",
      renderScopeSample(params.scopeSample),
      "```",
    );
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

/** Mechanical verification of a repair candidate. Compile always; for
 *  failure classes with recorded evidence, evaluate for real — an
 *  `empty_result` repair must produce a non-empty value, an
 *  `eval_error` repair must not throw. JS candidates go through the
 *  same QuickJS sandbox the execution layer uses (parse-only check
 *  when there is nothing to evaluate against). */
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

/**
 * Run the bounded repair. Never throws; never mutates anything.
 * `attempts` counts LLM round-trips actually made (success returns the
 * attempt index that produced the accepted candidate).
 */
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
