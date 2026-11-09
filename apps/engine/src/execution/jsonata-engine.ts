import type { Expression } from "jsonata";
import { instrument } from "../observability/runtime-telemetry.ts";
import { SandboxTimeoutError } from "../sandboxes/index.ts";
import { runSandboxWorkerJob } from "../sandboxes/quickjs/runtime.ts";
import { compile as compileUncached, formatError, JSONataError } from "./core/jsonata-contract.ts";

export {
  describeUnknownFunction,
  extractAst,
  findUnboundFunctionCalls,
  findUnknownFunctionCalls,
  formatError,
  JSONATA_BUILTIN_FUNCTIONS,
  JSONATA_FUNCTION_SUGGESTIONS,
  JSONataError,
  parseDeps,
} from "./core/jsonata-contract.ts";

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

export function isJSONataSandboxTimeout(error: unknown): boolean {
  return error instanceof JSONataError && error.cause instanceof SandboxTimeoutError;
}

const CACHE_LIMIT = 4096;
const JSONATA_SEQUENCE_CAP = 100_000;
const cache = new Map<string, Expression>();

export function compile(source: string): Expression {
  const existing = cache.get(source);
  if (existing) return existing;
  const expr = compileUncached(source);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(source, expr);
  return expr;
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

export function _resetCacheForTests(): void {
  cache.clear();
}
