// `dry_run_transform` — evaluate a JSONata / JavaScript / JSONPath /
// template expression against a supplied sample payload, without
// touching the workflow executor or the draft.
//
// The LLM uses this to debug transform expressions on the fly. Without
// it, the only way to validate an expression shape is to commit a
// draft, trigger a run, and read the execution row — five extra round
// trips per iteration. A direct probe is an order of magnitude cheaper.
//
// Four dialects are supported:
//
//   - `jsonata`    — real `jsonata` evaluator (matches transform steps).
//   - `javascript` — QuickJS sandbox, identical to transform steps with
//                    `language: "javascript"`: the expression is a
//                    FUNCTION BODY receiving exactly one value, the
//                    `input` argument, shaped `{ scope, input }` —
//                    upstream data at `input.scope.<step_id>.data…`,
//                    workflow input at `input.input`; the body must
//                    `return` its result. Failures classify exactly
//                    like the recorded-eval JS pass: compile_error /
//                    eval_error.
//   - `jsonpath`   — subkit's JSONPath-lite (matches data_selector).
//   - `template`   — placeholder substitution via resolver (no DB
//                    lookups; only ${input.*}/${scope.*} are resolved
//                    against the sample; ${cred.*}/${connector.*}
//                    yield diagnostic errors).
//
// Outputs the evaluated value, duration, and — on error — a structured
// error with an approximate source position where the evaluator
// reported a failure. Audit metadata records an expression hash (never
// the raw expression, since it might contain PII) plus the dialect.

import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import type { Expression } from "jsonata";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { buildJsonataBindings } from "../../execution/jsonata-bindings.ts";
import {
  compile as compileJsonata,
  formatError as formatJsonataError,
} from "../../execution/jsonata-engine.ts";
import { applySelector } from "../../execution/selectors.ts";
import { parsePlaceholders } from "../../llm/substitution/parser.ts";
import { resolveStringPlaceholders } from "../../llm/substitution/resolver.ts";
import { recordExecutionDryRun } from "../../observability/instrumentation.ts";
import { getWorkflowDraft } from "../authoring-state.ts";
import { evaluateJsBody, JS_EVAL_WALL_MS } from "../js-transform-eval.ts";
import {
  repairTransformExpression,
  type TransformRepairFailureKind,
  type TransformRepairOutcome,
} from "../transform-repair.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { getLastPreview } from "./last-preview-store.ts";

const Dialect = z.enum(["jsonata", "javascript", "jsonpath", "template"]);

const DryRunInput = z
  .object({
    expression: z.string().min(1).max(10_000),
    sample_data: z
      .unknown()
      .default(null)
      .describe(
        [
          "Sample input for the expression.",
          'A literal OBJECT becomes the scope record: each top-level key is a step id, so `{ "scrape_prices": { "data": {…} } }` is read as `input.scope.scrape_prices.data` in a javascript body (exactly the production shape).',
          'The workflow-input slot `input.input` is populated ONLY from an `input` key on that object — to set it, pass `{ "input": {…}, "<step_id>": {…} }`.',
          "A literal array/scalar rides `input.input` with an empty `input.scope`.",
          "To pull REAL recorded upstream data instead of hand-shaping it, pass the string `$scope`, `$scope.<step_id>`, or `$input` (resolved from the latest dry_run_workflow preview).",
        ].join(" "),
      ),
    // Transforms are JavaScript — default the probe to the same language so
    // an author testing a transform body gets execution-parity by default.
    // jsonata/jsonpath/template remain available for the one-line slots
    // (data_selector, branch.when, output_transform, ${…} interpolation).
    dialect: Dialect.default("javascript"),
    /**
     * Optional draft step id to emulate. When the step sits inside a
     * loop body, the evaluation reproduces the engine's per-iteration
     * childScope: `$item` and `$loop_index` are bound from the first
     * item of the loop's `over` collection resolved against the
     * recorded scope — identical surface to execution. For
     * `dialect: "javascript"` the same childScope rides `input.scope`,
     * so the body reads `input.scope.$item` / `input.scope.$loop_index`
     * exactly as execution builds them per iteration. Defaults
     * `sample_data` to `$scope` (the cached dry-run preview) when
     * omitted.
     */
    step_id: z.string().min(1).optional(),
    /** Optional timeout — capped at 2s to keep authoring UX snappy. */
    timeout_ms: z.number().int().min(50).max(2_000).default(1_000),
  })
  .openapi("DryRunTransformToolInput");

function hashExpr(expr: string): string {
  return createHash("sha256").update(expr).digest("hex").slice(0, 16);
}

interface EvalError {
  code:
    | "syntax_error"
    | "runtime_error"
    /** JS-only — the recorded-eval sandbox vocabulary. */
    | "compile_error"
    | "eval_error"
    | "timeout"
    | "placeholder_unresolved"
    | "unsupported_dialect";
  message: string;
  position?: number;
}

async function evalJsonata(
  expression: string,
  sample: unknown,
  timeout_ms: number,
  bindings?: Record<string, unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: EvalError }> {
  let expr: Expression;
  try {
    expr = compileJsonata(expression);
  } catch (err) {
    const e = err as { message?: string; position?: number };
    return {
      ok: false,
      error: {
        code: "syntax_error",
        message: e.message ?? String(err),
        ...(typeof e.position === "number" ? { position: e.position } : {}),
      },
    };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), timeout_ms);
  try {
    const evalPromise = bindings
      ? expr.evaluate(sample, bindings).catch((err: unknown) => {
          throw formatJsonataError(err, expression);
        })
      : expr.evaluate(sample).catch((err: unknown) => {
          throw formatJsonataError(err, expression);
        });
    const value = await Promise.race<unknown>([
      evalPromise,
      new Promise((_, reject) => {
        ctrl.signal.addEventListener("abort", () => reject(new Error("timeout")), {
          once: true,
        });
      }),
    ]);
    return { ok: true, value };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "timeout") {
      return {
        ok: false,
        error: { code: "timeout", message: `evaluation exceeded ${timeout_ms}ms` },
      };
    }
    const e = err as { position?: number };
    return {
      ok: false,
      error: {
        code: "runtime_error",
        message: msg,
        ...(typeof e.position === "number" ? { position: e.position } : {}),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function evalJsonPath(
  expression: string,
  sample: unknown,
): { ok: true; value: unknown } | { ok: false; error: EvalError } {
  try {
    return { ok: true, value: applySelector(expression, sample) };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "syntax_error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export const dryRunTransformTool: ConversationTool = {
  name: "dry_run_transform",
  description:
    'Evaluate a transform expression — JSONata / JSONPath / template, or a `language: "javascript"` function body — against a supplied sample payload, without touching the workflow executor.',
  use_case:
    "Debug transform expressions in isolation: paste a probe_connector response as `sample_data`, tweak the expression, and see the result. Cuts authoring round-trips from five to one.",
  important_notes: [
    "Does NOT persist anything — no draft mutation, no execution row.",
    "JSONata evaluator is identical to the one used by `transform` steps; the JSONPath dialect mirrors `data_selector`.",
    `\`dialect: "javascript"\` evaluates a transform FUNCTION BODY under the same QuickJS sandbox as \`language: "javascript"\` transform steps: exactly one value, the \`input\` argument, shaped \`{ scope, input }\` — upstream data at \`input.scope.<step_id>.data…\`, workflow input at \`input.input\`; the body must \`return\` its result (no \`function\` wrapper, no module syntax). No host globals — no fetch/process/require/network. Fixed ${JS_EVAL_WALL_MS}ms wall clock (\`timeout_ms\` does not extend it). Failures classify as \`compile_error\` (syntax) / \`eval_error\` (throw), identical to the recorded-eval JS pass.`,
    `Template dialect resolves \${input.*} and \${scope.*} only; \${cred.*}/\${connector.*} are not looked up and produce placeholder_unresolved.`,
    "Expression is timed out at 1s by default (max 2s) to keep authoring UX responsive.",
    "Audit metadata records only an expression hash + dialect — the raw expression may contain PII and is never written.",
    "`sample_data` is normally a LITERAL JSON value (array, object, etc.). As a shortcut for transform-only iteration, you can also pass `$scope`, `$scope.<step_id>`, or `$input` — the tool resolves these from the latest cached dry_run_workflow preview for this conversation, so you can debug a transform against real upstream data without rerunning the workflow.",
    "JSONata bindings are execution-identical: `$input`, `$scope`, `$steps`, and every `$`-prefixed scope key resolve exactly as they do in a `transform` step at runtime. For `javascript`, the resolved scope record IS `input.scope` and the recorded workflow input IS `input.input` — the exact production context shape.",
    "Pass `step_id` to emulate a draft step's runtime context. For a step inside a loop body, the tool binds `$item` and `$loop_index` from the first item of the loop's `over` collection resolved against the recorded scope — the same childScope the engine builds per iteration. Address the item as `$item.<path>` (JSONata) or `input.scope.$item.<path>` (javascript).",
    "On a compile/syntax error, runtime/eval error, or an empty result over a real scope (jsonata and javascript dialects), the result carries a bounded `repair` proposal in the same language (verified repaired expression with before/after, ≤2 attempts). Nothing is auto-applied — use the proposed expression in your next edit, or override it.",
  ],
  requires_skill: "data-handling",
  example_input: {
    expression:
      "const r = input.scope.fetch.data.results || []; return r.filter((x) => x.active).map((x) => x.id);",
    sample_data: { fetch: { data: { results: [{ id: "a", active: true }] } } },
    dialect: "javascript",
  },
  inputSchema: DryRunInput,
  category: "tenant_read",
  // Builds a definition rather than using one: withheld from the
  // read-and-execute tier even though it only reads.
  authoring_only: true,
  authoring_resource: "workflow",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const parsed = DryRunInput.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        ok: false,
        data: {
          persistence: "none" as const,
          error: {
            code: "invalid_input",
            message: "input failed zod validation",
            details: parsed.error.issues,
          },
        },
      };
    }
    const args = parsed.data;

    // Scope-reference resolution. When the caller passes a reference
    // string like `$scope`, `$scope.<step_id>`, or `$input` (typical
    // mistake: they're testing a JSONata transform against the last
    // dry-run's data), look up the cached scope for this conversation
    // and substitute. This is the path the "iterate on a transform
    // without re-hitting the upstream" workflow takes — without it,
    // sessions burn live API calls iterating JSONata.
    //
    // When `step_id` is given without sample_data, default to the
    // cached `$scope` — emulating a draft step implies the recorded
    // upstream data.
    const sampleInput: unknown =
      args.step_id !== undefined && (args.sample_data === null || args.sample_data === undefined)
        ? "$scope"
        : args.sample_data;
    let resolvedSampleData: unknown = sampleInput;
    let resolvedFromPreview: string | null = null;
    let evalBindings: Record<string, unknown> | undefined;
    /** Scope record + input the execution-parity bindings derive from. */
    let scopeRecord: Record<string, unknown> | null = null;
    let inputValue: unknown = null;
    if (typeof sampleInput === "string") {
      const trimmed = sampleInput.trim();
      const scopeRefMatch = /^\$scope(?:\.([A-Za-z_][\w]*))?$/.exec(trimmed);
      const isInputRef = trimmed === "$input";
      if (scopeRefMatch || isInputRef) {
        const preview = getLastPreview({
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
        });
        if (!preview) {
          return {
            ok: false,
            data: {
              persistence: "none" as const,
              error: {
                code: "runtime_error" as const,
                message: `sample_data references ${trimmed} but no cached dry-run preview exists for this conversation. Run dry_run_workflow once first, then iterate on the transform expression here.`,
              },
              metadata: { dialect: args.dialect, duration_ms: 0 },
            },
          };
        }
        if (isInputRef) {
          resolvedSampleData = preview.input;
          resolvedFromPreview = "$input";
          inputValue = preview.input;
        } else if (scopeRefMatch) {
          const stepId = scopeRefMatch[1];
          if (stepId) {
            if (!(stepId in preview.scope)) {
              return {
                ok: false,
                data: {
                  persistence: "none" as const,
                  error: {
                    code: "runtime_error" as const,
                    message: `sample_data references $scope.${stepId} but the cached preview has no step with that id. Available: ${Object.keys(
                      preview.scope,
                    )
                      .map((k) => `$scope.${k}`)
                      .join(", ")}`,
                  },
                  metadata: { dialect: args.dialect, duration_ms: 0 },
                },
              };
            }
            // Build a single-step sub-scope so the expression can use
            // either bare paths (`<step_id>.data`) or scoped paths
            // (`$scope.<step_id>.data`) against the same root.
            const singleScope: Record<string, unknown> = {
              [stepId]: preview.scope[stepId],
            };
            resolvedSampleData = singleScope;
            scopeRecord = singleScope;
            inputValue = preview.input;
            resolvedFromPreview = `$scope.${stepId}`;
          } else {
            resolvedSampleData = preview.scope;
            scopeRecord = preview.scope;
            inputValue = preview.input;
            resolvedFromPreview = "$scope";
          }
        }
      } else if (/^\s*(\$\.|\$\{)/.test(sampleInput)) {
        // Other placeholder shapes — refuse with the original guidance.
        return {
          ok: false,
          data: {
            persistence: "none" as const,
            error: {
              code: "runtime_error" as const,
              message: `sample_data is a reference string (${sampleInput.slice(
                0,
                80,
              )}) — pass the actual JSON payload instead. Use dry_run_step or inspect_authoring_context to capture real step output, then paste the value here.`,
            },
            metadata: { dialect: args.dialect, duration_ms: 0 },
          },
        };
      }
    } else if (
      sampleInput !== null &&
      typeof sampleInput === "object" &&
      !Array.isArray(sampleInput)
    ) {
      // Literal object sample — treat it as the scope record so the
      // execution-parity bindings below expose `$scope` / `$steps`
      // exactly like the transform driver does. A caller-supplied
      // `{ $scope: {…} }` wrapper also works: `buildJsonataBindings`
      // unpacks `$`-prefixed keys into the binding namespace.
      scopeRecord = sampleInput as Record<string, unknown>;
      inputValue = (sampleInput as Record<string, unknown>).input ?? null;
    }

    // Loop-body emulation: when the target draft step lives in
    // a loop body, execution binds `$item` and `$loop_index` into a
    // per-iteration childScope (see execution/loop-scope.ts).
    // Reproduce that surface here so the expression that works in this
    // sandbox is byte-identical to the one that works at runtime —
    // pre-fix the sandbox returned `{}` for those references and the
    // model concluded "scope doesn't work in loops" (session 784c1b02).
    // The `javascript` dialect rides the same childScope: it becomes
    // `input.scope`, so authored JS reads `input.scope.$item` /
    // `input.scope.$loop_index` exactly as execution builds them.
    let loopContext: { loop_id: string; loop_index: number } | null = null;
    const parityDialect = args.dialect === "jsonata" || args.dialect === "javascript";
    if (parityDialect && args.step_id !== undefined) {
      const draftSteps = getWorkflowDraft(ctx.getDraft()).steps;
      const targetExists = draftSteps.some((s) => s.id === args.step_id);
      if (!targetExists) {
        return {
          ok: false,
          data: {
            persistence: "none" as const,
            error: {
              code: "runtime_error" as const,
              message: `step_id \`${args.step_id}\` is not in the current workflow draft — pass the id of an existing draft step or omit step_id.`,
            },
            metadata: { dialect: args.dialect, duration_ms: 0 },
          },
        };
      }
      const enclosingLoop = draftSteps.find(
        (s) =>
          s.kind === "loop" &&
          Array.isArray(s.body) &&
          (s.body as unknown[]).includes(args.step_id as string),
      );
      if (enclosingLoop && scopeRecord) {
        const over = typeof enclosingLoop.over === "string" ? (enclosingLoop.over as string) : null;
        let items: unknown;
        if (over) {
          try {
            items = await compileJsonata(over).evaluate(
              scopeRecord,
              buildJsonataBindings(scopeRecord, inputValue),
            );
          } catch {
            items = undefined;
          }
        }
        if (!Array.isArray(items) || items.length === 0) {
          return {
            ok: false,
            data: {
              persistence: "none" as const,
              error: {
                code: "runtime_error" as const,
                message: `step \`${args.step_id}\` is inside loop \`${String(enclosingLoop.id)}\`, but the loop's \`over\` (${over ?? "(missing)"}) did not resolve to a non-empty array against the available scope. Run dry_run_workflow once so the upstream collection is recorded, then retry.`,
              },
              metadata: { dialect: args.dialect, duration_ms: 0 },
            },
          };
        }
        // Identical shape to the engine's per-iteration childScope
        // (mirrors execution/loop-scope.ts buildLoopChildScope).
        const childScope: Record<string, unknown> = {
          ...scopeRecord,
          $item: items[0],
          $loop_index: 0,
        };
        scopeRecord = childScope;
        resolvedSampleData = childScope;
        loopContext = {
          loop_id: String(enclosingLoop.id),
          loop_index: 0,
        };
      }
    }

    // Execution-parity bindings: the exact surface the engine's
    // transform driver builds — `$input`, `$scope`, `$steps`, plus every
    // `$`-prefixed scope key (`$item`, `$loop_index`, …) unpacked.
    if (args.dialect === "jsonata" && scopeRecord) {
      evalBindings = buildJsonataBindings(scopeRecord, inputValue);
    }

    const started = Date.now();
    let outcome: { ok: true; value: unknown } | { ok: false; error: EvalError };

    if (args.dialect === "jsonata") {
      outcome = await evalJsonata(
        args.expression,
        resolvedSampleData,
        args.timeout_ms,
        evalBindings,
      );
    } else if (args.dialect === "javascript") {
      // Exact production contract (execution/steps/transform.ts via
      // js-transform-eval.ts): QuickJS sandbox, one `input` value
      // shaped `{ scope, input }`. The scope record is the same one
      // the JSONata branch binds as `$scope` — including the loop
      // childScope built above, so `input.scope.$item` resolves
      // identically to execution. With no scope record (literal
      // scalar/array sample, or a `$input` reference), the sample
      // rides `input.input` and `input.scope` is empty.
      const jsEval = await evaluateJsBody({
        code: args.expression,
        scope: scopeRecord ?? {},
        input: scopeRecord ? inputValue : (resolvedSampleData ?? inputValue ?? null),
      });
      outcome = jsEval.ok
        ? { ok: true, value: jsEval.value }
        : { ok: false, error: { code: jsEval.kind, message: jsEval.message } };
    } else if (args.dialect === "jsonpath") {
      outcome = evalJsonPath(args.expression, resolvedSampleData);
    } else {
      // template: resolve ${input.*}/${scope.*} placeholders against the
      // sample. A ${cred.*} or ${connector.*} token is refused BEFORE the
      // resolver runs: the resolver would look it up, and the resolved
      // value — a decrypted credential field, a connector config leaf —
      // would come back in this tool's result, which the model reads.
      const sample = (resolvedSampleData ?? {}) as Record<string, unknown>;
      const lookups = parsePlaceholders(args.expression).tokens.filter(
        (t) => t.kind === "cred" || t.kind === "connector_url" || t.kind === "connector_config",
      );
      const r =
        lookups.length > 0
          ? { value: args.expression, unresolved: lookups.map((t) => ({ token: t.raw })) }
          : await resolveStringPlaceholders(args.expression, {
              tenant_id: ctx.tenant_id,
              environment: "dev",
              db: ctx.db,
              input: sample.input ?? sample,
              ...(sample.scope ? { scope: sample.scope as Record<string, unknown> } : {}),
            });
      if (r.unresolved.length > 0) {
        // Classified as unsupported here to steer the LLM back to the
        // connector-aware tools.
        outcome = {
          ok: false,
          error: {
            code: "placeholder_unresolved",
            message: `unresolved: ${r.unresolved.map((u) => u.token).join(", ")}`,
          },
        };
      } else {
        outcome = { ok: true, value: r.value };
      }
    }

    const duration_ms = Date.now() - started;

    // Bounded auto-repair (Fix 10) — propose-only, nothing is mutated.
    // A failing or empty jsonata evaluation gets ≤2 verified LLM repair
    // attempts; the outcome rides the result as `repair` so the model
    // applies the corrected expression on its next edit instead of
    // guessing syntax blind. Empty results only qualify when a real
    // scope record was resolved (literal scalar samples carry no
    // evidence to verify a non-empty repair against). Timeouts are
    // excluded: a repair can't prove anything about a runaway
    // expression.
    let repair: TransformRepairOutcome | null = null;
    if (args.dialect === "jsonata" || args.dialect === "javascript") {
      const isEmptyValue =
        outcome.ok &&
        (outcome.value === undefined ||
          outcome.value === null ||
          (Array.isArray(outcome.value) && outcome.value.length === 0));
      const failureKind: TransformRepairFailureKind | null = !outcome.ok
        ? outcome.error.code === "syntax_error" || outcome.error.code === "compile_error"
          ? "compile_error"
          : outcome.error.code === "runtime_error" || outcome.error.code === "eval_error"
            ? "eval_error"
            : null
        : isEmptyValue && scopeRecord
          ? "empty_result"
          : null;
      if (failureKind) {
        repair = await repairTransformExpression({
          expression: args.expression,
          language: args.dialect,
          finding: {
            kind: failureKind,
            message: !outcome.ok
              ? outcome.error.message
              : "expression evaluated to an empty result against the resolved scope",
            ...(!outcome.ok && typeof outcome.error.position === "number"
              ? { position: outcome.error.position }
              : {}),
          },
          scopeSample: scopeRecord,
          input: inputValue,
          site: "dry_run_transform",
          tenant_id: ctx.tenant_id,
          db: ctx.db,
        });
      }
    }

    recordExecutionDryRun({ tenant_id: ctx.tenant_id, source_kind: "transform" });

    // Audit — expression hash only; dialect; duration; ok flag.
    await auditAwait(
      {
        tenant_id: ctx.tenant_id,
        actor_type: ctx.actor_id ? "user" : "system",
        actor_id: ctx.actor_id,
        action: AuditAction.CONVERSATION_DRY_RUN_TRANSFORM,
        resource_type: "conversation",
        resource_id: ctx.conversation_id,
        result: outcome.ok ? "success" : "error",
        metadata: {
          conversation_id: ctx.conversation_id,
          dialect: args.dialect,
          expression_hash: hashExpr(args.expression),
          duration_ms,
          ok: outcome.ok,
        },
      },
      ctx.db,
    );

    if (!outcome.ok) {
      return {
        ok: false,
        data: {
          persistence: "none" as const,
          error: outcome.error,
          ...(repair ? { repair } : {}),
          metadata: {
            dialect: args.dialect,
            duration_ms,
            ...(resolvedFromPreview ? { resolved_from_preview: resolvedFromPreview } : {}),
            ...(args.step_id !== undefined ? { step_id: args.step_id } : {}),
            ...(loopContext ? { loop_context: loopContext } : {}),
          },
        },
      };
    }
    return {
      ok: true,
      data: {
        persistence: "none" as const,
        value: outcome.value,
        ...(repair ? { repair } : {}),
        metadata: {
          dialect: args.dialect,
          duration_ms,
          ...(resolvedFromPreview ? { resolved_from_preview: resolvedFromPreview } : {}),
          ...(args.step_id !== undefined ? { step_id: args.step_id } : {}),
          ...(loopContext ? { loop_context: loopContext } : {}),
        },
      },
    };
  },
};
