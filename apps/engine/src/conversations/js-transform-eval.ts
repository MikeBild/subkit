import { runJs } from "../sandboxes/quickjs/runtime.ts";
import { SandboxError, SandboxSyntaxError } from "../sandboxes/quickjs/types.ts";

export const JS_EVAL_WALL_MS = 500;

export type JsBodyEvalOutcome =
  | { ok: true; value: unknown }
  | { ok: false; kind: "compile_error" | "eval_error"; message: string };

export async function checkJsBodySyntax(
  code: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await runJs({
      code: `const __authored__ = (function (input) {\n${code}\n});\nreturn true;`,
      input: null,
      limits: { wall_ms: JS_EVAL_WALL_MS },
      clock: null,
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof SandboxSyntaxError) return { ok: false, message: err.message };
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function runBody(code: string, input: unknown): Promise<JsBodyEvalOutcome> {
  try {
    const result = await runJs({
      code,
      input,
      limits: { wall_ms: JS_EVAL_WALL_MS },
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

export function evaluateJsBody(args: {
  code: string;
  scope: Record<string, unknown>;
  input: unknown;
}): Promise<JsBodyEvalOutcome> {
  return runBody(args.code, { scope: args.scope, input: args.input ?? null });
}

export function evaluateJsOutputFunction(args: {
  code: string;
  root: unknown;
}): Promise<JsBodyEvalOutcome> {
  return runBody(args.code, args.root);
}

const JS_SCOPE_REF_PATTERNS = [
  /\binput\??\.scope\??\.([A-Za-z_$][A-Za-z0-9_$]*)/g,
  /\binput\??\.scope\[\s*["']([^"'\]]+)["']\s*\]/g,
];

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
