import jsonata, { type Expression } from "jsonata";
import { instrument } from "../observability/runtime-telemetry.ts";

export type EvalBindings = {
  input?: unknown;
  scope?: Record<string, unknown>;
  cred?: Record<string, Record<string, string>>;
  connector?: Record<string, Record<string, unknown>>;
  env?: Record<string, string>;
  loop_index?: number;
  loop_item?: unknown;
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
  ) {
    super(message);
    this.name = "JSONataError";
    this.source = source;
    this.position = position;
    this.lineNumber = lineNumber;
    this.column = column;
    this.token = token;
  }
}

const CACHE_LIMIT = 4096;
const cache = new Map<string, Expression>();

export function compile(source: string): Expression {
  const existing = cache.get(source);
  if (existing) return existing;
  let expr: Expression;
  try {
    expr = jsonata(source);
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

export async function evaluate<T = unknown>(
  source: string,
  data: unknown,
  bindings: EvalBindings = {},
): Promise<T> {
  const expr = compile(source);
  const flat = flattenBindings(bindings);
  return instrument({
    module: "execution",
    action: "jsonata",
    level: "debug",
    thresholdMs: 250,
    fn: async () => {
      try {
        return (await expr.evaluate(data, flat)) as T;
      } catch (err) {
        throw formatError(err, source);
      }
    },
  });
}

export function flattenBindings(bindings: EvalBindings): Record<string, unknown> {
  const flat: Record<string, unknown> = {
    input: bindings.input ?? null,
    scope: bindings.scope ?? {},
    cred: bindings.cred ?? {},
    connector: bindings.connector ?? {},
    env: bindings.env ?? {},
  };
  if (bindings.loop_index !== undefined) flat.loop_index = bindings.loop_index;
  if (bindings.loop_item !== undefined) flat.loop_item = bindings.loop_item;
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
