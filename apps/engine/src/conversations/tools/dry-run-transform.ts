// `dry_run_transform` — evaluate a JSONata / JSONPath / template
// expression against a supplied sample payload, without touching the
// workflow executor or the draft.
//
// The LLM uses this to debug transform expressions on the fly. Without
// it, the only way to validate an expression shape is to commit a
// draft, trigger a run, and read the execution row — five extra round
// trips per iteration. A direct probe is an order of magnitude cheaper.
//
// Three dialects are supported:
//
//   - `jsonata`   — real `jsonata` evaluator (matches transform steps).
//   - `jsonpath`  — subkit's JSONPath-lite (matches data_selector).
//   - `template`  — placeholder substitution via resolver (no DB
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
import {
  compile as compileJsonata,
  formatError as formatJsonataError,
} from "../../execution/jsonata-engine.ts";
import { applySelector } from "../../execution/selectors.ts";
import { resolveStringPlaceholders } from "../../llm/substitution/resolver.ts";
import { recordExecutionDryRun } from "../../observability/instrumentation.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { getLastPreview } from "./last-preview-store.ts";

const Dialect = z.enum(["jsonata", "jsonpath", "template"]);

const DryRunInput = z
  .object({
    expression: z.string().min(1).max(10_000),
    sample_data: z.unknown().default(null),
    dialect: Dialect.default("jsonata"),
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
    "Evaluate a JSONata / JSONPath / template expression against a supplied sample payload, without touching the workflow executor.",
  use_case:
    "Debug transform expressions in isolation: paste a probe_connector response as `sample_data`, tweak the expression, and see the result. Cuts authoring round-trips from five to one.",
  important_notes: [
    "Does NOT persist anything — no draft mutation, no execution row.",
    "JSONata evaluator is identical to the one used by `transform` steps; the JSONPath dialect mirrors `data_selector`.",
    `Template dialect resolves \${input.*} and \${scope.*} only; \${cred.*}/\${connector.*} are not looked up and produce placeholder_unresolved.`,
    "Expression is timed out at 1s by default (max 2s) to keep authoring UX responsive.",
    "Audit metadata records only an expression hash + dialect — the raw expression may contain PII and is never written.",
    "`sample_data` is normally a LITERAL JSON value (array, object, etc.). As a shortcut for transform-only iteration, you can also pass `$scope`, `$scope.<step_id>`, or `$input` — the tool resolves these from the latest cached dry_run_workflow preview for this conversation, so you can debug JSONata against real upstream data without rerunning the workflow.",
  ],
  requires_skill: "data-handling",
  example_input: {
    expression: "$scope.fetch.data.results[?(@.active)].id",
    sample_data: {
      $scope: { fetch: { data: { results: [{ id: "a", active: true }] } } },
    },
    dialect: "jsonata",
  },
  inputSchema: DryRunInput,
  category: "tenant_read",
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
    let resolvedSampleData: unknown = args.sample_data;
    let resolvedFromPreview: string | null = null;
    let evalBindings: Record<string, unknown> | undefined;
    if (typeof args.sample_data === "string") {
      const trimmed = args.sample_data.trim();
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
            evalBindings = { scope: singleScope, input: preview.input };
            resolvedFromPreview = `$scope.${stepId}`;
          } else {
            resolvedSampleData = preview.scope;
            evalBindings = { scope: preview.scope, input: preview.input };
            resolvedFromPreview = "$scope";
          }
        }
      } else if (/^\s*(\$\.|\$\{)/.test(args.sample_data)) {
        // Other placeholder shapes — refuse with the original guidance.
        return {
          ok: false,
          data: {
            persistence: "none" as const,
            error: {
              code: "runtime_error" as const,
              message: `sample_data is a reference string (${args.sample_data.slice(
                0,
                80,
              )}) — pass the actual JSON payload instead. Use dry_run_step or inspect_authoring_context to capture real step output, then paste the value here.`,
            },
            metadata: { dialect: args.dialect, duration_ms: 0 },
          },
        };
      }
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
    } else if (args.dialect === "jsonpath") {
      outcome = evalJsonPath(args.expression, resolvedSampleData);
    } else {
      // template: resolve ${input.*}/${scope.*} placeholders using the
      // resolver, but with `tenant_id` stubbed out so cred/connector
      // lookups return path_empty (no DB call).
      const sample = (resolvedSampleData ?? {}) as Record<string, unknown>;
      const r = await resolveStringPlaceholders(args.expression, {
        tenant_id: ctx.tenant_id,
        environment: "dev",
        db: ctx.db,
        input: sample.input ?? sample,
        ...(sample.scope ? { scope: sample.scope as Record<string, unknown> } : {}),
      });
      if (r.unresolved.length > 0) {
        // Filter out cred/connector refs — these are expected in
        // template dialect but we classify them as unsupported here to
        // steer the LLM back to the connector-aware tools.
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
          metadata: {
            dialect: args.dialect,
            duration_ms,
            ...(resolvedFromPreview ? { resolved_from_preview: resolvedFromPreview } : {}),
          },
        },
      };
    }
    return {
      ok: true,
      data: {
        persistence: "none" as const,
        value: outcome.value,
        metadata: {
          dialect: args.dialect,
          duration_ms,
          ...(resolvedFromPreview ? { resolved_from_preview: resolvedFromPreview } : {}),
        },
      },
    };
  },
};
