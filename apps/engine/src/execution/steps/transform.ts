// Transform step driver. Supports two languages:
//   - `jsonata` (default): the expression is a JSONata program
//     evaluated against the execution scope plus a `$input` binding.
//   - `javascript` (P14): the expression is a function body executed in
//     the QuickJS sandbox. The JS sees `input` with the full execution
//     scope, and its return value becomes the step output.
//
// The transform timeout tier (default 10 minutes) applies to both
// languages — JSONata races against an abort signal; JavaScript races
// against the QuickJS wall-clock budget plus the same abort signal.

import jsonata from "jsonata";
import { logger } from "../../logging/logger.ts";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";
import {
  SandboxInterruptError,
  SandboxMemoryError,
  SandboxTimeoutError,
} from "../../sandboxes/quickjs/types.ts";
import type { TransformStep } from "../../workflows/types.ts";
import { combineSignals } from "../abort.ts";
import type { StepResult, StepRunContext, StepWarning } from "../types.ts";

export const TRANSFORM_TIMEOUT_DEFAULT_MS = 10 * 60_000;

export interface RunTransformParams {
  ctx: StepRunContext;
  step: TransformStep;
  scope: Record<string, unknown>;
  input: unknown;
}

// Walk a parsed jsonata AST collecting top-level identifiers — the
// first step of any `path` node, plus standalone `variable` nodes
// (`$foo`). Any identifier not in `known` surfaces as an
// `unresolved_identifier` warning. Walker handles arbitrary nesting
// (object constructors wrap pairs inside `lhs` arrays; function calls
// hide children in `arguments`, etc.) by recursing over every own
// property.
interface AstNode {
  type?: string;
  value?: unknown;
  steps?: unknown;
}

function visitRootIdentifiers(node: unknown, emit: (id: string) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) visitRootIdentifiers(child, emit);
    return;
  }
  const ast = node as AstNode;
  if (ast.type === "path" && Array.isArray(ast.steps) && ast.steps.length >= 1) {
    const head = ast.steps[0] as AstNode | undefined;
    if (head?.type === "name" && typeof head.value === "string") emit(head.value);
    if (head?.type === "variable" && typeof head.value === "string") emit(`$${head.value}`);
  }
  if (ast.type === "variable" && typeof ast.value === "string") emit(`$${ast.value}`);
  for (const [k, v] of Object.entries(ast)) {
    if (k === "type" || k === "value" || k === "position") continue;
    visitRootIdentifiers(v, emit);
  }
}

// Jsonata built-ins that appear as `$fn(...)` — must not be flagged.
const JSONATA_BUILTINS = new Set([
  "$",
  "$$",
  "$sum",
  "$count",
  "$max",
  "$min",
  "$average",
  "$string",
  "$number",
  "$boolean",
  "$not",
  "$exists",
  "$length",
  "$substring",
  "$substringBefore",
  "$substringAfter",
  "$uppercase",
  "$lowercase",
  "$trim",
  "$pad",
  "$contains",
  "$split",
  "$join",
  "$match",
  "$replace",
  "$eval",
  "$now",
  "$millis",
  "$fromMillis",
  "$toMillis",
  "$keys",
  "$lookup",
  "$spread",
  "$merge",
  "$map",
  "$filter",
  "$reduce",
  "$sift",
  "$each",
  "$sort",
  "$reverse",
  "$shuffle",
  "$distinct",
  "$zip",
  "$append",
  "$round",
  "$floor",
  "$ceil",
  "$abs",
  "$power",
  "$sqrt",
  "$random",
  "$formatNumber",
  "$formatBase",
  "$formatInteger",
  "$parseInteger",
  "$type",
  "$error",
  "$assert",
  "$base64encode",
  "$base64decode",
  "$encodeUrlComponent",
  "$decodeUrlComponent",
  "$encodeUrl",
  "$decodeUrl",
]);

function detectUnresolvedIdentifiers(
  expression: string,
  scope: Record<string, unknown>,
  bindings: Record<string, unknown>,
): StepWarning[] {
  let ast: AstNode;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: jsonata's .ast() is untyped.
    ast = (jsonata(expression) as any).ast() as AstNode;
  } catch {
    return [];
  }
  const known = new Set<string>();
  for (const k of Object.keys(scope)) known.add(k);
  for (const k of Object.keys(bindings)) known.add(`$${k}`);
  // `$` is the context item; always valid.
  known.add("$");
  // jsonata exposes bound names as `$name`; also accept the bare name.
  for (const k of Object.keys(bindings)) known.add(k);

  const unresolved = new Set<string>();
  visitRootIdentifiers(ast, (id) => {
    if (!id) return;
    if (id.startsWith("$") && JSONATA_BUILTINS.has(id)) return;
    if (known.has(id)) return;
    unresolved.add(id);
  });
  return [...unresolved].map((identifier) => ({
    code: "unresolved_identifier" as const,
    identifier,
    message: `jsonata expression referenced "${identifier}" but no matching key was in scope or bindings`,
  }));
}

export async function runTransformStep(p: RunTransformParams): Promise<StepResult> {
  const start = Date.now();
  const timeoutMs = p.step.timeout_ms ?? TRANSFORM_TIMEOUT_DEFAULT_MS;
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort("timeout"), timeoutMs);
  const signal = combineSignals([p.ctx.signal, timeoutCtrl.signal]);
  const language = p.step.language ?? "jsonata";
  try {
    if (language === "javascript") {
      // QuickJS already enforces its own wall-clock safety net — we
      // pass the step timeout as `wall_ms` and race against the same
      // abort signal so external cancels still land.
      const jsPromise = runJs({
        code: p.step.expression,
        input: { scope: p.scope, input: p.input },
        limits: { wall_ms: timeoutMs },
      });
      const raced = await Promise.race([
        jsPromise,
        new Promise((_, reject) => {
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      ]);
      return {
        status: "succeeded",
        output: (raced as { output: unknown }).output,
        retry_count: 0,
        duration_ms: Date.now() - start,
      };
    }
    const expr = jsonata(p.step.expression);
    // Bindings available inside the expression:
    //   $input     — the execution input (same object the workflow was
    //                invoked with).
    //   $scope     — the full step-output scope. `$scope.fetch_repos` is
    //                the same as the bare path `fetch_repos`.
    //   $steps     — alias of $scope. Some authors prefer the name
    //                "$steps.id.field" because it reads more clearly.
    //   $step_meta — per-step metadata (status_code, duration_ms, url,
    //                method, bytes_in for request steps; duration_ms +
    //                retry_count for every step). Accessed as
    //                `$step_meta.fetch_repos.status_code`.
    //   $<key>     — every `$`-prefixed key on scope (e.g. `$loop_index`)
    //                is unpacked. Plain (non-`$`) keys remain
    //                addressable as bare path expressions against the
    //                root context object.
    const bindings: Record<string, unknown> = {
      input: p.input,
      scope: p.scope,
      steps: p.scope,
    };
    for (const [k, v] of Object.entries(p.scope)) {
      if (k.startsWith("$") && k.length > 1) {
        bindings[k.slice(1)] = v;
      }
    }
    const warnings = detectUnresolvedIdentifiers(p.step.expression, p.scope, bindings);
    // race jsonata.evaluate against the abort signal
    const evalPromise = expr.evaluate(p.scope, bindings);
    const result = await Promise.race([
      evalPromise,
      new Promise((_, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ]);
    const out: StepResult = {
      status: "succeeded",
      output: result,
      retry_count: 0,
      duration_ms: Date.now() - start,
    };
    if (warnings.length > 0) {
      out.warnings = warnings;
      logger.info({
        module: "execution",
        action: "step.transform.warnings",
        step_id: p.step.id,
        warnings: warnings.map((w) => w.identifier).filter(Boolean),
      });
    }
    return out;
  } catch (err) {
    const duration_ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof SandboxTimeoutError || err instanceof SandboxInterruptError) {
      logger.warn({
        module: "execution",
        action: "step.transform.timeout",
        step_id: p.step.id,
        language,
        timeout_ms: timeoutMs,
        duration_ms,
      });
      return {
        status: "timed_out",
        retry_count: 0,
        duration_ms,
        error: { code: "transform_timeout", message: `transform exceeded ${timeoutMs}ms` },
      };
    }
    if (err instanceof SandboxMemoryError) {
      logger.warn({
        module: "execution",
        action: "step.transform.memory_error",
        step_id: p.step.id,
        language,
        duration_ms,
        error: message,
      });
      return {
        status: "failed",
        retry_count: 0,
        duration_ms,
        error: { code: "transform_memory", message },
      };
    }
    if (timeoutCtrl.signal.aborted && !p.ctx.signal.aborted) {
      logger.warn({
        module: "execution",
        action: "step.transform.timeout",
        step_id: p.step.id,
        language,
        timeout_ms: timeoutMs,
        duration_ms,
      });
      return {
        status: "timed_out",
        retry_count: 0,
        duration_ms,
        error: { code: "transform_timeout", message: `transform exceeded ${timeoutMs}ms` },
      };
    }
    if (p.ctx.signal.aborted) {
      return {
        status: "aborted",
        retry_count: 0,
        duration_ms,
        error: { code: "aborted", message: "execution aborted" },
      };
    }
    logger.warn({
      module: "execution",
      action: "step.transform.error",
      step_id: p.step.id,
      language,
      duration_ms,
      error: message,
    });
    return {
      status: "failed",
      retry_count: 0,
      duration_ms,
      error: { code: "transform_error", message },
    };
  } finally {
    clearTimeout(timer);
  }
}
