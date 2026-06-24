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

/** Drop the cached Langfuse client so the next `getClient()` call
 *  reads the current config. Two callers:
 *    1. Production hot-reload — `config/loader.ts:setConfigKey` invokes
 *       this whenever an `observability.*` leaf changes, so the next
 *       span sends to the newly-configured project.
 *    2. Tests — let a follow-up test re-mock the env without booting
 *       a fresh process.
 *  Renamed from `_resetLangfuseCache` (4.2.0) to drop the underscore-
 *  prefix-implies-test-only convention; the function carries real
 *  production weight. */
export function resetLangfuseCacheForReload(): void {
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

// ---- per-tool observation metadata builders --------------------------------
//
// Each builder receives the ALREADY-REDACTED args (redactPayload is applied
// by startToolSpan before the builder runs — builders never see raw args).
// They return additional metadata fields to merge into the span metadata.
// When the field is absent or non-string, it is omitted rather than
// surfaced as null, keeping the span compact.
//
// Truncation rules shared across builders:
//   - Array fields: cap at ARRAY_CAP entries.
//   - String payloads (query, path, error): truncate at STRING_CAP chars.
//   - URL fields: hostname-only (no credentials, no path, no query).

const ARRAY_CAP = 12;
const STRING_CAP = 512;

function capArray<T>(arr: T[]): T[] {
  return arr.length > ARRAY_CAP ? arr.slice(0, ARRAY_CAP) : arr;
}

function capString(s: string): string {
  return s.length > STRING_CAP ? `${s.slice(0, STRING_CAP)}…` : s;
}

/** Extract hostname-only from a URL string. Returns undefined on parse failure. */
function hostnameOnly(rawUrl: unknown): string | undefined {
  if (typeof rawUrl !== "string" || !rawUrl) return undefined;
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

type RedactedArgs = Record<string, unknown>;

/** Author/build-workflow tool: step/system identifiers and draft-vs-saved target. */
function buildAuthorMeta(args: RedactedArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const stepId = str(args.step_id) ?? str(args.step);
  if (stepId) out.step_id = capString(stepId);
  const systemId = str(args.system_id) ?? str(args.workflow_id);
  if (systemId) out.system_id = capString(systemId);
  const target =
    str(args.target) ??
    (args.draft === true ? "draft" : args.draft === false ? "saved" : undefined);
  if (target) out.target = target;
  const conversationId = str(args.conversation_id);
  if (conversationId) out.conversation_id = conversationId;
  return out;
}

/** Run/execute-workflow tool: target kind and inclusion flags. */
function buildRunMeta(args: RedactedArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const kind = str(args.kind) ?? str(args.target_kind);
  if (kind) out.target_kind = kind;
  const draftFlag = bool(args.draft);
  if (draftFlag !== undefined) out.draft = draftFlag;
  const includeConnectors = bool(args.include_connectors);
  if (includeConnectors !== undefined) out.include_connectors = includeConnectors;
  const includeSkills = bool(args.include_skills);
  if (includeSkills !== undefined) out.include_skills = includeSkills;
  return out;
}

/** Edit/patch tool: patch paths applied/rejected. */
function buildPatchMeta(args: RedactedArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const applied = Array.isArray(args.applied_paths)
    ? capArray(args.applied_paths as unknown[])
    : undefined;
  if (applied) out.applied_paths = applied;
  const rejected = Array.isArray(args.rejected_paths)
    ? capArray(args.rejected_paths as unknown[])
    : undefined;
  if (rejected) out.rejected_paths = rejected;
  const patchCount = typeof args.patch_count === "number" ? args.patch_count : undefined;
  if (patchCount !== undefined) out.patch_count = patchCount;
  return out;
}

/** Connector-call tool: protocol and hostname only (no credentials, no query string). */
function buildConnectorMeta(args: RedactedArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const protocol = str(args.protocol) ?? str(args.driver);
  if (protocol) out.protocol = protocol;
  const host = hostnameOnly(args.url) ?? hostnameOnly(args.base_url) ?? str(args.host);
  if (host) out.host = host;
  const slug = str(args.slug) ?? str(args.connector_slug);
  if (slug) out.connector_slug = capString(slug);
  return out;
}

/** Find/search tool: lookup mode and query keywords (truncated). */
function buildSearchMeta(args: RedactedArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const mode = str(args.mode) ?? str(args.lookup_mode);
  if (mode) out.lookup_mode = mode;
  const query = str(args.query) ?? str(args.keywords) ?? str(args.q);
  if (query) out.query = capString(query);
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  if (limit !== undefined) out.limit = limit;
  return out;
}

// Tool-name → builder mapping. Each key is a substring that can appear in
// tool names; the first match wins. This deliberately avoids branching on
// brand names or exact tool names so the builders survive renames.
const TOOL_META_BUILDERS: Array<{
  match: (name: string) => boolean;
  build: (args: RedactedArgs) => Record<string, unknown>;
}> = [
  {
    // Author / build / draft tools (e.g. author_workflow, save_workflow_draft)
    match: (n) => /author|draft|build_workflow|save_workflow/.test(n),
    build: buildAuthorMeta,
  },
  {
    // Run / execute tools (e.g. run_workflow, dry_run_workflow, execute_step)
    match: (n) => /\brun\b|execute|dry_run/.test(n),
    build: buildRunMeta,
  },
  {
    // Edit / patch tools (e.g. apply_patch, propose_step_patch)
    match: (n) => /patch|edit_step|repair/.test(n),
    build: buildPatchMeta,
  },
  {
    // Connector-call tools (e.g. probe_connector, call_connector)
    match: (n) => /connector|probe/.test(n),
    build: buildConnectorMeta,
  },
  {
    // Find / search tools (e.g. search_knowledge, find_connector, lookup_*)
    match: (n) => /search|find|lookup/.test(n),
    build: buildSearchMeta,
  },
];

/**
 * Enrich a span's metadata with tool-specific fields. `redactedArgs` MUST
 * have already passed through `redactPayload` — this function does NOT
 * re-run redaction. Returns the merged metadata object.
 */
export function enrichSpanMetadata(
  toolName: string,
  redactedArgs: unknown,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const args =
    redactedArgs !== null && typeof redactedArgs === "object" && !Array.isArray(redactedArgs)
      ? (redactedArgs as RedactedArgs)
      : {};
  for (const entry of TOOL_META_BUILDERS) {
    if (entry.match(toolName)) {
      return { ...base, ...entry.build(args) };
    }
  }
  return base;
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
  // Redact FIRST — builders only receive the sanitised payload.
  const redactedInput = redactPayload(p.input);
  const baseMeta = p.metadata ?? {};
  // Enrich with per-tool metadata using the already-redacted input.
  const enrichedMeta = enrichSpanMetadata(p.name, redactedInput, baseMeta);
  const trace = client.trace({
    name: p.name,
    metadata: enrichedMeta,
    ...(baseMeta.session_id ? { sessionId: String(baseMeta.session_id) } : {}),
  });
  const span = trace.span({
    name: p.name,
    input: redactedInput,
    metadata: enrichedMeta,
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
