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

export function resetLangfuseCacheForReload(): void {
  cachedClient = undefined;
}

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

const SENSITIVE_VALUE_PATTERNS = [/^Bearer\s+\S{8,}/, /^(?=.*[a-z])(?=.*[0-9])[A-Za-z0-9_-]{32,}$/];

const PLACEHOLDER_TOKEN_RE = /\$\{cred\.[^}]+\}/g;

function isSensitiveKey(key: string): boolean {
  const lc = key.toLowerCase();
  return SENSITIVE_KEY_SUBSTRINGS.some((m) => lc.includes(m));
}

function isSensitiveValue(v: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) {
    return false;
  }
  return SENSITIVE_VALUE_PATTERNS.some((re) => re.test(v));
}

function redactString(s: string): string {
  let out = s.replace(PLACEHOLDER_TOKEN_RE, `\${cred.REDACTED}`);
  if (isSensitiveValue(out)) {
    out = "[REDACTED]";
  }
  return out;
}

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

const ARRAY_CAP = 12;
const STRING_CAP = 512;

function capArray<T>(arr: T[]): T[] {
  return arr.length > ARRAY_CAP ? arr.slice(0, ARRAY_CAP) : arr;
}

function capString(s: string): string {
  return s.length > STRING_CAP ? `${s.slice(0, STRING_CAP)}…` : s;
}

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

const TOOL_META_BUILDERS: Array<{
  match: (name: string) => boolean;
  build: (args: RedactedArgs) => Record<string, unknown>;
}> = [
  {
    match: (n) => /author|draft|edit_workflow|save_workflow/.test(n),
    build: buildAuthorMeta,
  },
  {
    match: (n) => /\brun\b|execute|dry_run/.test(n),
    build: buildRunMeta,
  },
  {
    match: (n) => /patch|edit_step|repair/.test(n),
    build: buildPatchMeta,
  },
  {
    match: (n) => /connector|probe/.test(n),
    build: buildConnectorMeta,
  },
  {
    match: (n) => /search|find|lookup/.test(n),
    build: buildSearchMeta,
  },
];

function enrichSpanMetadata(
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

interface ToolSpanHandle {
  readonly active: boolean;
  readonly finish: (p: {
    output?: unknown;
    status?: "success" | "error";
    error?: unknown;
  }) => Promise<void>;
}

interface StartToolSpanParams {
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

export async function startToolSpan(p: StartToolSpanParams): Promise<ToolSpanHandle> {
  const client = await getClient();
  if (!client) {
    return {
      active: false,
      finish: async () => {},
    };
  }
  const redactedInput = redactPayload(p.input);
  const baseMeta = p.metadata ?? {};
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
