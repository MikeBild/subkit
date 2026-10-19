import jsonata, { type Expression } from "jsonata";
import { instrument } from "../observability/runtime-telemetry.ts";
import { SandboxTimeoutError } from "../sandboxes/index.ts";
import { runSandboxWorkerJob } from "../sandboxes/quickjs/runtime.ts";

export type EvalBindings = {
  [name: string]: unknown;
  input?: unknown;
  caller?: unknown;
  scope?: Record<string, unknown>;
  cred?: Record<string, Record<string, string>>;
  connector?: Record<string, Record<string, unknown>>;
  env?: Record<string, string>;
  loop_index?: number;
  loop_item?: unknown;
  clock?: { now_ms: number; seed?: string };
};

export class JSONataError extends Error {
  readonly source: string;
  readonly position: number | undefined;
  readonly lineNumber: number | undefined;
  readonly column: number | undefined;
  readonly token: string | undefined;

  constructor(
    source: string,
    position: number | undefined,
    lineNumber: number | undefined,
    column: number | undefined,
    token: string | undefined,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "JSONataError";
    this.source = source;
    this.position = position;
    this.lineNumber = lineNumber;
    this.column = column;
    this.token = token;
  }
}

export function isJSONataSandboxTimeout(error: unknown): boolean {
  return error instanceof JSONataError && error.cause instanceof SandboxTimeoutError;
}

const CACHE_LIMIT = 4096;
const cache = new Map<string, Expression>();
const JSONATA_AST_DEPTH_CAP = 256;
const JSONATA_SEQUENCE_CAP = 100_000;
const JSONATA_SOURCE_CAP = 256 * 1024;
function rejectsNondeterminism(source: string): void {
  if (/\$\s*(?:random|shuffle|eval)\b/i.test(source)) {
    throw new JSONataError(
      source,
      undefined,
      undefined,
      undefined,
      undefined,
      "JSONata random, shuffle, and eval functions are not available in deterministic execution",
    );
  }
}

export function compile(source: string): Expression {
  if (Buffer.byteLength(source) > JSONATA_SOURCE_CAP) {
    throw new JSONataError(
      source,
      undefined,
      undefined,
      undefined,
      undefined,
      "JSONata expression exceeds the maximum source length",
    );
  }
  rejectsNondeterminism(source);
  const existing = cache.get(source);
  if (existing) return existing;
  let expr: Expression;
  try {
    expr = jsonata(source);
    expr.registerFunction("random", () => {
      throw new Error("JSONata random is not available in deterministic execution");
    });
    expr.registerFunction("shuffle", () => {
      throw new Error("JSONata shuffle is not available in deterministic execution");
    });
    assertAstDepth(expr, source);
  } catch (err) {
    throw formatError(err, source);
  }
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(source, expr);
  return expr;
}

function assertAstDepth(expr: Expression, source: string): void {
  const ast = (expr as Expression & { ast?: () => unknown }).ast?.();
  const visit = (value: unknown, depth: number): void => {
    if (depth > JSONATA_AST_DEPTH_CAP) {
      throw new JSONataError(
        source,
        undefined,
        undefined,
        undefined,
        undefined,
        "JSONata expression exceeds the maximum AST depth",
      );
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    for (const entry of Object.values(value)) visit(entry, depth + 1);
  };
  visit(ast, 0);
}

function assertResultSize(value: unknown, source: string): void {
  if (Array.isArray(value) && value.length > JSONATA_SEQUENCE_CAP) {
    throw new JSONataError(
      source,
      undefined,
      undefined,
      undefined,
      undefined,
      "JSONata result exceeds the maximum sequence length",
    );
  }
}

export async function evaluate<T = unknown>(
  source: string,
  data: unknown,
  bindings: EvalBindings = {},
): Promise<T> {
  compile(source);
  const flat = flattenBindings(bindings);
  return instrument({
    module: "execution",
    action: "jsonata",
    level: "debug",
    thresholdMs: 250,
    fn: async () => {
      try {
        return (await runSandboxWorkerJob({
          op: "evaluate_jsonata",
          source,
          data,
          bindings: flat,
          clock: bindings.clock ?? null,
          wall_ms: 1_000,
        })) as T;
      } catch (err) {
        throw formatError(err, source);
      }
    },
  });
}

export async function evaluateJsonataInCurrentProcess<T = unknown>(p: {
  source: string;
  data: unknown;
  bindings: Record<string, unknown>;
  clock: { now_ms: number; seed?: string } | null;
}): Promise<T> {
  const expr = compile(p.source);
  try {
    expr.registerFunction("random", () => {
      throw new Error("JSONata random is not available in deterministic execution");
    });
    expr.registerFunction("shuffle", () => {
      throw new Error("JSONata shuffle is not available in deterministic execution");
    });
    expr.registerFunction("eval", () => {
      throw new Error("JSONata eval is not available in deterministic execution");
    });
    if (p.clock) {
      const nowMs = p.clock.now_ms;
      expr.registerFunction("now", () => new Date(nowMs).toISOString());
      expr.registerFunction("millis", () => nowMs);
    }
    const value = await expr.evaluate(p.data, p.bindings);
    assertResultSize(value, p.source);
    return value as T;
  } catch (err) {
    throw formatError(err, p.source);
  }
}

export function flattenBindings(bindings: EvalBindings): Record<string, unknown> {
  const flat: Record<string, unknown> = {
    input: bindings.input ?? null,
    caller: bindings.caller ?? bindings.scope?.$caller ?? null,
    scope: bindings.scope ?? {},
    cred: bindings.cred ?? {},
    connector: bindings.connector ?? {},
    env: bindings.env ?? {},
  };
  if (bindings.loop_index !== undefined) flat.loop_index = bindings.loop_index;
  if (bindings.loop_item !== undefined) flat.loop_item = bindings.loop_item;
  for (const [name, value] of Object.entries(bindings)) {
    if (name === "clock" || name in flat || value === undefined) continue;
    flat[name] = value;
  }
  return flat;
}

export interface ExprDeps {
  inputs: ReadonlyArray<string>;
  steps: ReadonlyArray<string>;
  creds: ReadonlyArray<string>;
  connectors: ReadonlyArray<string>;
  env: ReadonlyArray<string>;
}

export interface JSONataCallableFinding {
  name: string;
  position: number | undefined;
  suggestion: string;
}

export function findUnboundFunctionCalls(source: string): JSONataCallableFinding[] {
  const expr = compile(source);
  const ast = (expr as Expression & { ast?: () => unknown }).ast?.();
  if (!ast || typeof ast !== "object") return [];

  const findings: JSONataCallableFinding[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === "function") {
      const procedure = node.procedure as Record<string, unknown> | undefined;
      const steps =
        procedure?.type === "path" && Array.isArray(procedure.steps) ? procedure.steps : [];
      const target =
        steps.length === 1 ? (steps[0] as Record<string, unknown> | undefined) : undefined;
      if (target?.type === "name" && typeof target.value === "string") {
        const position = typeof target.position === "number" ? target.position : undefined;
        const key = `${target.value}:${position ?? "unknown"}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({ name: target.value, position, suggestion: `$${target.value}` });
        }
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(ast);
  return findings;
}

export const JSONATA_BUILTIN_FUNCTIONS: ReadonlySet<string> = new Set([
  "sum",
  "count",
  "max",
  "min",
  "average",
  "string",
  "substring",
  "substringBefore",
  "substringAfter",
  "lowercase",
  "uppercase",
  "length",
  "trim",
  "pad",
  "match",
  "contains",
  "replace",
  "split",
  "join",
  "formatNumber",
  "formatBase",
  "formatInteger",
  "parseInteger",
  "number",
  "floor",
  "ceil",
  "round",
  "abs",
  "sqrt",
  "power",
  "boolean",
  "not",
  "map",
  "zip",
  "filter",
  "single",
  "reduce",
  "sift",
  "keys",
  "lookup",
  "append",
  "exists",
  "spread",
  "merge",
  "reverse",
  "each",
  "error",
  "assert",
  "type",
  "sort",
  "distinct",
  "encodeUrlComponent",
  "encodeUrl",
  "decodeUrlComponent",
  "decodeUrl",
  "base64encode",
  "base64decode",
  "toMillis",
  "fromMillis",
  "clone",
  "now",
  "millis",
]);

export const JSONATA_FUNCTION_SUGGESTIONS: Readonly<Record<string, string>> = {
  indexOf: "`($arr#$i[$ = value].$i)[0]` — bind the array with `:=` first; `#$i` exposes the index",
  findIndex: "`($arr#$i[<condition>].$i)[0]`",
  includes: "`value in $arr`",
  find: "`$filter($arr, function($v) { <condition> })[0]`",
  length: "`$count($arr)` for arrays (`$length` is string length only)",
  toUpperCase: "`$uppercase(str)`",
  toFixed: "`$round(num, decimals)`",
  slice: "`$arr[[0..n-1]]` (range predicate)",
  parseFloat: "`$number(str)`",
  concat: "`$append($a, $b)`",
  push: "`$append($arr, value)`",
};

export interface JSONataUnknownFunctionFinding {
  name: string;
  position?: number;
  suggestion: string | null;
}

export function findUnknownFunctionCalls(source: string): JSONataUnknownFunctionFinding[] {
  const ast: unknown = compile(source).ast();
  const bound = new Set<string>();
  const calls: Array<{ name: string; position: number | undefined }> = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === "bind") {
      const lhs = node.lhs as Record<string, unknown> | undefined;
      if (lhs?.type === "variable" && typeof lhs.value === "string") bound.add(lhs.value);
    }
    if (node.type === "lambda" && Array.isArray(node.arguments)) {
      for (const argument of node.arguments as Array<Record<string, unknown> | undefined>) {
        if (argument?.type === "variable" && typeof argument.value === "string") {
          bound.add(argument.value);
        }
      }
    }
    if (node.type === "function") {
      const procedure = node.procedure as Record<string, unknown> | undefined;
      if (procedure?.type === "variable" && typeof procedure.value === "string") {
        calls.push({
          name: procedure.value,
          position: typeof procedure.position === "number" ? procedure.position : undefined,
        });
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(ast);

  const findings: JSONataUnknownFunctionFinding[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    if (JSONATA_BUILTIN_FUNCTIONS.has(call.name) || bound.has(call.name)) continue;
    const key = `${call.name}:${call.position ?? "unknown"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      name: call.name,
      ...(call.position !== undefined ? { position: call.position } : {}),
      suggestion: JSONATA_FUNCTION_SUGGESTIONS[call.name] ?? null,
    });
  }
  return findings;
}

export function describeUnknownFunction(f: JSONataUnknownFunctionFinding): string {
  return (
    `JSONata has no function \`$${f.name}\`` +
    (f.suggestion
      ? `; use ${f.suggestion}`
      : " — only JSONata built-ins and functions bound with := function(...) are callable")
  );
}

export function parseDeps(source: string): ExprDeps {
  const inputs = new Set<string>();
  const steps = new Set<string>();
  const creds = new Set<string>();
  const connectors = new Set<string>();
  const env = new Set<string>();
  const re = /\$(input|scope|cred|connector|env)\.([A-Za-z_][\w.]*)/g;
  for (const m of source.matchAll(re)) {
    const root = m[1] as keyof ExprDeps | "scope" | "input" | "cred" | "connector" | "env";
    const path = m[2] ?? "";
    if (root === "input") inputs.add(path);
    else if (root === "scope") steps.add(path.split(".")[0] ?? path);
    else if (root === "cred") creds.add(path);
    else if (root === "connector") connectors.add(path);
    else if (root === "env") env.add(path);
  }
  return {
    inputs: [...inputs],
    steps: [...steps],
    creds: [...creds],
    connectors: [...connectors],
    env: [...env],
  };
}

export function extractAst(source: string): unknown | null {
  let expr: Expression;
  try {
    expr = compile(source);
  } catch {
    return null;
  }
  try {
    const ast = (expr as Expression & { ast?: () => unknown }).ast?.();
    return ast ?? null;
  } catch {
    return null;
  }
}

export function _resetCacheForTests(): void {
  cache.clear();
}

export function formatError(err: unknown, source: string): JSONataError {
  const e = err as
    | {
        position?: number;
        lineNumber?: number;
        column?: number;
        token?: string;
        message?: unknown;
      }
    | undefined;
  const position = e?.position;
  const lineNumber = e?.lineNumber;
  const column = e?.column;
  const token = e?.token;
  const baseMessage = coerceMessage(e?.message);
  const location = lineNumber !== undefined ? ` at L${lineNumber}:${column}` : "";
  const caret =
    position !== undefined ? `\n  ${source.slice(0, position)}█${source.slice(position)}` : "";
  return new JSONataError(
    source,
    position,
    lineNumber,
    column,
    token,
    `JSONata error${location}: ${baseMessage}${caret}`,
    err,
  );
}

function coerceMessage(raw: unknown): string {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (raw === null || raw === undefined) return "JSONata error";
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  try {
    const json = JSON.stringify(raw);
    if (json && json !== "{}") return json;
  } catch {}
  return "JSONata error";
}
