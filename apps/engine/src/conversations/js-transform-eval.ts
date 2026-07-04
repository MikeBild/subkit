// Shared JS-transform evaluation helpers for the authoring surface
// (recorded-eval, transform-repair). One contract, verified against
// `sandboxes/quickjs/runtime.ts` + `execution/steps/transform.ts`:
//
//   - The authored code is a FUNCTION BODY (not a module, not an arrow
//     function). `runJs` wraps it as `(function(input){ <body> })` and
//     invokes it once; the body must `return` its result (a trailing
//     expression also works).
//   - Exactly ONE value is exposed: the `input` argument. Transform
//     steps call `runJs({ code, input: { scope, input } })`, so the
//     authored body addresses upstream data as
//     `input.scope.<step_id>.data…` and the workflow input as
//     `input.input`.
//   - The sandbox is QuickJS WASM, fail-closed, zero host globals — no
//     fetch / process / require / network. Recorded evaluation
//     therefore can NEVER egress, same guarantee the JSONata branch
//     gives by construction.
//
// Failure mapping (sandbox error → authoring finding):
//   SandboxSyntaxError                  → compile_error
//   every other SandboxError / throw    → eval_error

import { runJs } from "../sandboxes/quickjs/runtime.ts";
import { SandboxError, SandboxSyntaxError } from "../sandboxes/quickjs/types.ts";

/** Tight wall-clock cap for authoring-time JS evaluation — recorded
 *  evaluation must never make a tool call feel like a dry-run. Matches
 *  the JSONata recorded-eval / repair-verification bound. */
export const JS_EVAL_WALL_MS = 500;

export type JsBodyEvalOutcome =
  | { ok: true; value: unknown }
  | { ok: false; kind: "compile_error" | "eval_error"; message: string };

/**
 * Syntax-only check of an authored function body: the body is wrapped
 * as an UNINVOKED function expression inside the sandbox, so QuickJS
 * parses it (surfacing any SyntaxError with the runtime's own message)
 * without executing a single statement of it.
 */
export async function checkJsBodySyntax(
  code: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await runJs({
      code: `const __authored__ = (function (input) {\n${code}\n});\nreturn true;`,
      input: null,
      limits: { wall_ms: JS_EVAL_WALL_MS },
      // Authoring-time syntax check — no execution context, intentionally
      // constant clock.
      clock: null,
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof SandboxSyntaxError) return { ok: false, message: err.message };
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Evaluate an authored function body against a recorded scope with the
 * exact production context shape (`execution/steps/transform.ts`):
 * `input = { scope, input }`. Never throws — sandbox failures come back
 * as a classified outcome.
 */
export async function evaluateJsBody(args: {
  code: string;
  scope: Record<string, unknown>;
  input: unknown;
}): Promise<JsBodyEvalOutcome> {
  try {
    const result = await runJs({
      code: args.code,
      input: { scope: args.scope, input: args.input ?? null },
      limits: { wall_ms: JS_EVAL_WALL_MS },
      // Recorded-eval authoring preview — no live execution instant to
      // thread, intentionally constant clock.
      clock: null,
    });
    return { ok: true, value: result.output };
  } catch (err) {
    if (err instanceof SandboxSyntaxError) {
      return { ok: false, kind: "compile_error", message: err.message };
    }
    if (err instanceof SandboxError) {
      return { ok: false, kind: "eval_error", message: err.message };
    }
    return {
      ok: false,
      kind: "eval_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

const JS_SCOPE_REF_PATTERNS = [
  // input.scope.fetch / input?.scope?.fetch
  /\binput\??\.scope\??\.([A-Za-z_$][A-Za-z0-9_$]*)/g,
  // input.scope["fetch-items"] / input.scope['fetch-items']
  /\binput\??\.scope\[\s*["']([^"'\]]+)["']\s*\]/g,
];

/**
 * Step ids referenced from an authored JS body — the JS counterpart of
 * `extractStepIdReferences` (which knows the `$scope.<id>` JSONata
 * forms). Dot access and quoted bracket access are both recognised;
 * bracket form covers ids JS dot-syntax cannot express (dashes).
 */
export function extractJsScopeReferences(code: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const re of JS_SCOPE_REF_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const id = m[1] ?? "";
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}
