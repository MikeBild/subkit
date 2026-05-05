// Langfuse-aware tool spans with defense-in-depth redaction.
//
// Subkit already ships OpenTelemetry-over-Langfuse for LLM calls (see
// observability/tracing.ts). That layer captures per-model latency and
// token accounting. What it does NOT cover is the tool-execution level:
// which tool the LLM called, what input it passed, what output came
// back. Those spans live outside the AI SDK's `experimental_telemetry`
// and need a direct Langfuse client.
//
// This module is:
//   1. A thin wrapper over the `langfuse` SDK (lazy-imported, no dep
//      on initialisation when the key is absent).
//   2. A redaction pipeline applied to every payload before it leaves
//      the process: strips ${cred.*} placeholder tokens, masks any
//      value that looks like an API key / bearer token, and masks keys
//      named `authorization`, `api_key`, `secret`, `token`, `password`,
//      `cookie`, `x-api-key`.
//
// Usage:
//
//   const span = startToolSpan({
//     name: "probe_connector",
//     input: rawArgs,
//     metadata: { tenant_id, conversation_id, tool, category },
//   });
//   try {
//     const result = await tool.execute(...);
//     endToolSpan(span, { output: result, status: "success" });
//   } catch (err) {
//     endToolSpan(span, { error: err, status: "error" });
//     throw err;
//   }
//
// The span object is opaque — callers treat it like a token. When the
// Langfuse key is not set the span is a dummy and all calls are free.

import { getConfig } from "../config/loader.ts";
import { logger } from "../logging/logger.ts";

interface LangfuseTraceHandle {
  span: (payload: { name: string; input?: unknown; metadata?: Record<string, unknown> }) => {
    end: (payload: {
      output?: unknown;
      level?: "DEFAULT" | "WARNING" | "ERROR";
      statusMessage?: string;
    }) => void;
  };
}

interface LangfuseClient {
  trace: (payload: {
    name: string;
    metadata?: Record<string, unknown>;
    sessionId?: string;
    userId?: string;
  }) => LangfuseTraceHandle;
  shutdownAsync: () => Promise<void>;
}

let cachedClient: LangfuseClient | null | undefined;

async function getClient(): Promise<LangfuseClient | null> {
  if (cachedClient !== undefined) return cachedClient;
  let cfg: { secret_key: string; public_key: string; host: string };
  try {
    cfg = getConfig().observability.langfuse;
  } catch {
    // Loader not initialised (unit tests that don't boot the engine).
    cachedClient = null;
    return null;
  }
  if (!cfg.secret_key || !cfg.public_key) {
    cachedClient = null;
    return null;
  }
  try {
    const mod = await import("langfuse");
    const LangfuseClass = (
      mod as { Langfuse: new (opts: Record<string, unknown>) => LangfuseClient }
    ).Langfuse;
    cachedClient = new LangfuseClass({
      secretKey: cfg.secret_key,
      publicKey: cfg.public_key,
      baseUrl: cfg.host || "https://cloud.langfuse.com",
    });
    return cachedClient;
  } catch (err) {
    logger.warn({
      module: "observability.langfuse_spans",
      action: "init_failed",
      msg: "langfuse SDK failed to initialise — spans will be no-ops",
      error: err instanceof Error ? err.message : String(err),
    });
    cachedClient = null;
    return null;
  }
}

/** Test-only: reset the cached client so a follow-up test can remock env. */
export function _resetLangfuseCache(): void {
  cachedClient = undefined;
}

// ---- redaction ------------------------------------------------------------

// Matching is deliberately loose: a key is treated as sensitive if
// its lowercased form contains any of the substring markers. This
// catches camelCase (`ClientSecret`), snake_case (`client_secret`),
// kebab-case (`x-api-key`), and uppercase (`PASSWORD`) in one pass.
const SENSITIVE_KEY_SUBSTRINGS = [
  "authorization",
  "apikey",
  "api_key",
  "api-key",
  "secret",
  "password",
  "cookie",
  "token",
  "bearer",
  "refresh",
];

const SENSITIVE_VALUE_PATTERNS = [
  // Bearer tokens: `Bearer sk_live_xxxxxxxx`
  /^Bearer\s+\S{8,}/,
  // Obvious secret-looking strings: any alphanum + dash + underscore >= 24 chars
  // that doesn't look like a UUID (we keep UUIDs for correlation).
  /^(?=.*[a-z])(?=.*[0-9])[A-Za-z0-9_-]{32,}$/,
];

const PLACEHOLDER_TOKEN_RE = /\$\{cred\.[^}]+\}/g;

function isSensitiveKey(key: string): boolean {
  const lc = key.toLowerCase();
  return SENSITIVE_KEY_SUBSTRINGS.some((m) => lc.includes(m));
}

function isSensitiveValue(v: string): boolean {
  // UUID passthrough — used as tenant/connector ids, safe to surface.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) {
    return false;
  }
  return SENSITIVE_VALUE_PATTERNS.some((re) => re.test(v));
}

function redactString(s: string): string {
  // Known placeholder tokens stay readable (they're not secrets) but
  // get a visible marker so operators know redaction ran.
  let out = s.replace(PLACEHOLDER_TOKEN_RE, `\${cred.REDACTED}`);
  if (isSensitiveValue(out)) {
    out = "[REDACTED]";
  }
  return out;
}

/** Deep-redact a JSON-like payload. Pure. Never throws. Arrays and
 *  objects are copied; primitives are returned as-is unless they match
 *  a sensitive-value pattern. */
export function redactPayload(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }
  if (Array.isArray(value)) return value.map(redactPayload);
  if (typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (isSensitiveKey(k)) {
        out[k] = "[REDACTED]";
        continue;
      }
      out[k] = redactPayload(v);
    }
    return out;
  }
  return value;
}

// ---- span API -------------------------------------------------------------

export interface ToolSpanHandle {
  readonly active: boolean;
  readonly finish: (p: {
    output?: unknown;
    status?: "success" | "error";
    error?: unknown;
  }) => Promise<void>;
}

export interface StartToolSpanParams {
  name: string;
  input?: unknown;
  metadata?: {
    tenant_id?: string;
    conversation_id?: string;
    tool?: string;
    category?: string;
    session_id?: string;
    [k: string]: unknown;
  };
}

/** Create a tool-level span. When Langfuse is not configured, returns
 *  an inert span whose `finish` is a no-op. */
export async function startToolSpan(p: StartToolSpanParams): Promise<ToolSpanHandle> {
  const client = await getClient();
  if (!client) {
    return {
      active: false,
      finish: async () => {},
    };
  }
  const trace = client.trace({
    name: p.name,
    metadata: p.metadata ?? {},
    ...(p.metadata?.session_id ? { sessionId: String(p.metadata.session_id) } : {}),
  });
  const span = trace.span({
    name: p.name,
    input: redactPayload(p.input),
    metadata: p.metadata ?? {},
  });
  let finished = false;
  return {
    active: true,
    finish: async (f) => {
      if (finished) return;
      finished = true;
      const level: "DEFAULT" | "ERROR" = f.status === "error" || f.error ? "ERROR" : "DEFAULT";
      const statusMessage = (() => {
        if (f.error instanceof Error) return f.error.message;
        if (typeof f.error === "string") return f.error;
        return undefined;
      })();
      try {
        span.end({
          output: redactPayload(f.output),
          level,
          ...(statusMessage ? { statusMessage } : {}),
        });
      } catch (err) {
        logger.debug({
          module: "observability.langfuse_spans",
          action: "span.end_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
