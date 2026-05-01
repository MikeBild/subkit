// Single entry point for evaluating JSONata expressions in the sk engine.
//
// Solves the four well-known JSONata pain points (researched from
// `jsonata-js/jsonata` issues + Reco's `gnata` writeup, which saved
// $500K/yr just from compile caching):
//
//   1. **Compile cache** — `jsonata(expr)` is expensive; cache parsed
//      Expressions. Bounded FIFO eviction at CACHE_LIMIT.
//   2. **Structured errors** — JSONata throws `{ position, lineNumber,
//      column, token, message }`; raw they're cryptic. Wrap with caret-
//      pointed source via `JSONataError`.
//   3. **Typed bindings** — every call site uses the same `EvalBindings`
//      shape (`input` / `scope` / `cred` / `connector` / `env` /
//      `loop_index` / `loop_item`); the host-side flattening into
//      JSONata's `$`-prefixed names happens once, here.
//   4. **Static analysis** — `parseDeps()` extracts identifier
//      references (regex-based, since the JS impl exposes no public
//      AST API) for input-schema synth + RBAC pre-check.
//
// Every direct `jsonata(...)` call in the engine should route through
// `compile` / `evaluate` here. CI grep gate enforces this (see WS8.4).

import jsonata, { type Expression } from "jsonata";

export type EvalBindings = {
  /** Workflow input (top-level); accessible as `$input` in expressions. */
  input?: unknown;
  /** Step outputs by step_id; accessible as `$scope.<id>`. */
  scope?: Record<string, unknown>;
  /** Resolved credentials by connector slug; RBAC-gated. `$cred.<slug>.<key>`. */
  cred?: Record<string, Record<string, string>>;
  /** Connector configs by slug; RBAC-gated. `$connector.<slug>.<key>`. */
  connector?: Record<string, Record<string, unknown>>;
  /** Allow-listed environment values. `$env.<KEY>`. */
  env?: Record<string, string>;
  /** Present inside a `loop` step body. */
  loop_index?: number;
  /** Present inside a `loop` step body. */
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

/**
 * Compile a JSONata expression once and cache it. Subsequent calls with
 * the same source return the cached Expression — orders of magnitude
 * faster than re-parsing per evaluation.
 *
 * Throws `JSONataError` if the expression fails to parse.
 */
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
    // FIFO eviction — drop the oldest entry. Map iteration order is
    // insertion order in JS, so `keys().next().value` is the oldest.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(source, expr);
  return expr;
}

/**
 * Evaluate a JSONata expression against a JSON data root and the
 * structured engine bindings. The bindings are flattened into JSONata's
 * `$`-prefixed namespace (`$input`, `$scope`, `$cred`, `$connector`,
 * `$env`, `$loop_index`, `$loop_item`).
 *
 * Throws `JSONataError` for either a parse failure (cached after the
 * first attempt) or an evaluation failure.
 */
export async function evaluate<T = unknown>(
  source: string,
  data: unknown,
  bindings: EvalBindings = {},
): Promise<T> {
  const expr = compile(source);
  const flat = flattenBindings(bindings);
  try {
    return (await expr.evaluate(data, flat)) as T;
  } catch (err) {
    throw formatError(err, source);
  }
}

/**
 * Flatten the typed `EvalBindings` shape into JSONata's `$`-prefixed
 * binding map. Public so legacy callers that already build their own
 * data root can reuse the convention without re-implementing it.
 */
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

/**
 * Static dependency analysis. Returns the identifier roots referenced by
 * the expression — used by `input-schema-synth` to derive the workflow's
 * declared inputs, and by RBAC pre-check to verify only allowed
 * `cred.<slug>` / `connector.<slug>` keys are referenced.
 *
 * Implementation: regex over the source. The JS implementation of
 * JSONata exposes no public `.ast()` method (verified in pass-5: only
 * Go/Rust impls have `AST()`); regex covers every user-meaningful
 * reference and is good enough for authoring-time validation.
 */
export interface ExprDeps {
  inputs: ReadonlyArray<string>;
  steps: ReadonlyArray<string>;
  creds: ReadonlyArray<string>;
  connectors: ReadonlyArray<string>;
  env: ReadonlyArray<string>;
}

export function parseDeps(source: string): ExprDeps {
  const inputs = new Set<string>();
  const steps = new Set<string>();
  const creds = new Set<string>();
  const connectors = new Set<string>();
  const env = new Set<string>();
  // Match `$<root>.<segment>(.<segment>...)` where root is one of the
  // known namespaces. Non-greedy on segments to capture the leaf path.
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

/**
 * Extract the JSONata AST for static analysis. Used by
 * `input-schema-synth` to derive declared inputs from `transform` /
 * `branch` expressions, and by `transform` step setup to enable
 * binding-aware evaluation.
 *
 * Returns `null` if compilation fails or the AST hook is unavailable.
 * Callers should treat that as "no signal" rather than retry.
 *
 * Implementation note: the JS impl of JSONata exposes `ast()` on the
 * compiled Expression in v2.x but it's not part of the public typed
 * API. Centralising the cast here means a future JSONata release that
 * removes it only breaks one file.
 */
export function extractAst(source: string): unknown | null {
  let expr: Expression;
  try {
    expr = compile(source);
  } catch {
    return null;
  }
  try {
    // biome-ignore lint/suspicious/noExplicitAny: jsonata's .ast() is untyped.
    const ast = (expr as any).ast?.();
    return ast ?? null;
  } catch {
    return null;
  }
}

/**
 * Test-only — clear the compile cache. Production code should never
 * need this; tests that exercise cache eviction or per-test isolation
 * may.
 */
export function _resetCacheForTests(): void {
  cache.clear();
}

function formatError(err: unknown, source: string): JSONataError {
  const e = err as
    | {
        position?: number;
        lineNumber?: number;
        column?: number;
        token?: string;
        message?: string;
      }
    | undefined;
  const position = e?.position;
  const lineNumber = e?.lineNumber;
  const column = e?.column;
  const token = e?.token;
  const baseMessage = e?.message ?? "JSONata error";
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
