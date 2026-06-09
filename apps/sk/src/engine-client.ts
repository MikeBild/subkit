// Thin typed client over the subkit engine's REST API, scoped to the
// surfaces the `sk` end-user CLI needs. Hand-written rather than
// `hono/client` so the compiled binary stays tight — pulling the
// engine's `AppType` through Hono drags the entire server module
// graph in.
//
// Naming convention (R5-S4 review note): wire-shape fields stay
// snake_case to match the engine's OpenAPI surface — `tenant_id`,
// `tenant_slug`, `retry_after`, `trace_id`. Local-only fields use
// camelCase. This means TS callers occasionally see `err.retry_after`
// next to `err.message` / `err.code`; the snake_case names are the
// authoritative wire shape and are deliberate.

import {
  DIAGNOSTICS_DRIFT_PATH,
  DIAGNOSTICS_LOG_STREAM_PATH,
  DIAGNOSTICS_LOG_TAIL_PATH,
} from "@cli-core/diagnostics-paths.ts";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { AUDIT_SOURCE_HEADER, type AuditSource } from "@shared/audit-source.ts";
import { z } from "zod";

/** The CLI's channel tag on audit_log.metadata.audit_source. The
 *  engine validates against `AUDIT_SOURCE_VALUES` (shared package)
 *  at the route boundary; this constant just narrows the union to
 *  the value sk uses. */
const SK_CLI_AUDIT_SOURCE = "sk_cli" satisfies AuditSource;

import {
  type DebugCorrelationFields,
  type DebugMode,
  debugLog,
  extractTraceId,
  isDebugVerbose,
  serializeDebugError,
} from "./debug.ts";
import { isTransientSocketDrop } from "./repl/error-humanize.ts";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a synthetic ConversationRunOutcome from a conversation detail
 * after a transport-recovery path. Carries no events array — the UI
 * surfaces the recovery as a one-line notice and replays state from
 * the persisted conversation rows on the next render. The
 * `__recovered` marker lets the caller distinguish "real outcome" from
 * "we recovered, please re-render from getConversation" without
 * depending on a missing field.
 */
function synthesizeRecoveredOutcome(detail: ConversationDetail): ConversationRunOutcome & {
  __recovered: true;
} {
  // Emit a single synthesized `completed` event so the cli-core
  // reducer transitions the session out of "running" and the spinner
  // stops. We don't replay the lost text_deltas / tool events — the
  // engine persisted the row, but reconstructing per-step events from
  // the detail would risk drift. Forcing the user to send a prompt
  // (or pull /status) to fully resync is acceptable; what matters is
  // that the spinner stops and the UI doesn't pretend the engine is
  // still mid-turn.
  const status = detail.conversation.status;
  const completedStatus =
    status === "awaiting_input"
      ? "awaiting_input"
      : status === "completed"
        ? "completed"
        : "active";
  return {
    conversation: detail.conversation,
    events: [
      {
        type: "completed",
        status: completedStatus,
        usage: null,
      },
    ],
    status,
    __recovered: true,
  };
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// ---------- Files wire types ----------
// Mirror `apps/engine/src/api/files-schemas.ts`. Kept structural (not
// Zod) here so the CLI's tsc graph doesn't pull in @hono/zod-openapi.

// ---------- Stats wire types (#160) ----------
// Mirror apps/engine/src/http/routes/stats/schemas.ts. Kept structural
// (not Zod) so the CLI tsc graph doesn't pull in @hono/zod-openapi.

export interface StatsQuery {
  // Index signature so the query object is accepted by `request`'s
  // `Record<string, string | number | boolean | undefined>` param.
  [key: string]: string | number | boolean | undefined;
  bucket: string;
  from: string;
  to?: string;
  tz?: string;
  group_by?: string;
  // route-specific filters (comma-joined for multi-value):
  workflow_id?: string;
  status?: string;
  request_source?: string;
  execution_mode?: string;
  connector_id?: string;
  connector_slug?: string;
  driver?: string;
  method?: string;
  outcome?: string;
  status_class?: string;
  include_endpoint?: boolean;
  class?: string;
  model?: string;
  flow?: string;
}

export interface StatsDurationAgg {
  total: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}
export type StatsLatencyAgg = StatsDurationAgg;
export interface StatsTokenAgg {
  prompt: number;
  completion: number;
  cache_read: number;
  cache_creation: number;
  total: number;
}

interface StatsEnvelope {
  bucket: string;
  tz: string;
  from: string;
  to: string;
  truncated_at?: string;
}

export interface StatsExecutionsResponse extends StatsEnvelope {
  groups: Array<{
    key: Record<string, string>;
    buckets: Array<{ ts: string; executions: number; duration_ms: StatsDurationAgg }>;
    totals: { executions: number; duration_ms: StatsDurationAgg };
  }>;
  totals: {
    executions: { count: number; by_status: Record<string, number> };
    duration_ms: StatsDurationAgg;
  };
}

export interface StatsAuditResponse extends StatsEnvelope {
  groups: Array<{
    key: Record<string, string>;
    buckets: Array<{
      ts: string;
      calls: number;
      latency_ms: StatsLatencyAgg;
      outcomes: { success: number; denied: number; error: number };
    }>;
    totals: {
      calls: { total: number; by_outcome: { success: number; denied: number; error: number } };
      latency_ms: StatsLatencyAgg;
    };
  }>;
  totals: {
    calls: {
      total: number;
      by_outcome: { success: number; denied: number; error: number };
      by_status_class: Record<string, number>;
    };
    latency_ms: StatsLatencyAgg;
  };
  truncated_endpoints?: boolean;
}

export interface StatsLlmResponse extends StatsEnvelope {
  groups: Array<{
    key: Record<string, string>;
    buckets: Array<{
      ts: string;
      calls: number;
      tokens: StatsTokenAgg;
      latency_ms: StatsLatencyAgg;
      result: Record<string, number>;
    }>;
    totals: { calls: number; tokens: StatsTokenAgg; latency_ms: StatsLatencyAgg };
  }>;
  totals: {
    calls: { total: number; by_result: Record<string, number> };
    tokens: StatsTokenAgg;
    latency_ms: StatsLatencyAgg;
  };
}

export type FileStatusWire = "pending" | "uploading" | "scanning" | "ready" | "failed" | "expired";

export interface FileWire {
  id: string;
  status: FileStatusWire;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  sha256: string | null;
  scan_result: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface BatchCreateEntry {
  filename: string;
  content_type?: string;
  size_bytes: number;
  sha256?: string;
}

export interface BatchCreateRequest {
  files: BatchCreateEntry[];
}

export interface BatchCreateResponseEntry {
  id: string;
  upload_url: string;
  headers: Record<string, string>;
  expires_in: number;
  dedup: boolean;
}

export interface BatchCreateResponse {
  files: BatchCreateResponseEntry[];
}

export interface FileLinkWire {
  id: string;
  file_id: string;
  resource_type: string;
  resource_id: string;
  slug: string | null;
  role: string | null;
  created_at: string;
}

export interface FileStatsWire {
  total: number;
  by_status: Record<string, number>;
  by_size_bucket: Record<string, number>;
  dedup_hits: number;
  scan_verdicts: Record<string, number>;
}

/** Inline-upload cap + link-resource-type enum — re-exported from the
 *  shared constants module so the CLI cannot drift from the engine's
 *  413 threshold or link-target whitelist. Above the inline cap the
 *  CLI must use `batchCreateFiles` + `putToPresignedUrl` +
 *  `finalizeFile`; the resource-type tuple is consumed by
 *  `parseResourceRef` to reject bad `--link-to` / `--linked-to`
 *  values locally. */
export {
  FILE_LINK_RESOURCE_TYPES,
  type FileLinkResourceType,
  MAX_INLINE_BYTES,
} from "@shared/files-constants.ts";

// ---------- Files Zod schemas ----------
// Mirror `apps/engine/src/api/files-schemas.ts` so a server that breaks
// the wire shape (or a future engine that adds an unknown field
// interpreted by the wrong path) is rejected at the CLI boundary
// instead of smuggled through as a TS-shape-only crash inside the
// command handler. Pattern matches `ForkResponseSchema` below — plain
// `zod`, no `@hono/zod-openapi` (CLI's tsc graph stays small).

const FileStatusWireSchema = z.enum([
  "pending",
  "uploading",
  "scanning",
  "ready",
  "failed",
  "expired",
]);

const FileWireSchema = z.object({
  id: z.string(),
  status: FileStatusWireSchema,
  filename: z.string(),
  content_type: z.string().nullable(),
  size_bytes: z.number(),
  sha256: z.string().nullable(),
  scan_result: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

const BatchCreateResponseEntrySchema = z.object({
  id: z.string(),
  upload_url: z.string(),
  headers: z.record(z.string(), z.string()),
  expires_in: z.number(),
  dedup: z.boolean(),
});

const BatchCreateResponseSchema = z.object({
  files: z.array(BatchCreateResponseEntrySchema),
});

const FileLinkWireSchema = z.object({
  id: z.string(),
  file_id: z.string(),
  resource_type: z.string(),
  resource_id: z.string(),
  slug: z.string().nullable(),
  role: z.string().nullable(),
  created_at: z.string(),
});

const FileStatsWireSchema = z.object({
  total: z.number(),
  by_status: z.record(z.string(), z.number()),
  by_size_bucket: z.record(z.string(), z.number()),
  dedup_hits: z.number(),
  scan_verdicts: z.record(z.string(), z.number()),
});

const FileListResponseSchema = z.object({
  items: z.array(FileWireSchema),
  next_cursor: z.string().nullable().optional(),
});

/**
 * Zod schema for the fork-from-message response so a server that
 * breaks the shape (or a future engine that adds an unknown field
 * interpreted by the wrong path) is rejected at the CLI boundary
 * instead of smuggled through as TS-shape-only.
 *
 * `conversation` is parsed loosely (the engine returns the full
 * ConversationSummary; we don't re-derive that schema here, that's
 * the OpenAPI client's job). The fields the CLI actually reads —
 * `id`, `tenant_id`, `title`, `created_at`, `updated_at`, `status` —
 * are pinned strictly so a contract drift on those is a parse error.
 */
const ForkResponseSchema = z.object({
  conversation: z
    .object({
      id: z.string().uuid(),
      tenant_id: z.string().uuid(),
      title: z.string().nullable(),
      status: z.string(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .passthrough(),
  source_conversation_id: z.string().uuid(),
  anchor_message_id: z.string().uuid(),
  copied_message_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export interface ClientOptions {
  engine_url: string;
  api_key: string;
  tenant?: string | null | undefined;
  fetchImpl?: FetchLike | undefined;
  /** User-Agent header value. sk-cli sets its own to tag audit rows. */
  user_agent?: string | undefined;
  /** Optional mode tag used in debug traces. */
  debug_mode?: DebugMode | undefined;
}

/** Discriminated union matching the engine's RunBodySchema for
 *  POST /v1/executions. Keep in sync with
 *  apps/engine/src/http/routes/executions.ts. */
export type RunExecutionBody =
  | {
      source: "saved";
      workflow_id: string;
      version_id?: string;
      input?: unknown;
      async?: boolean;
      request_source?: "api" | "cli" | "mcp" | "webhook" | "tool-chain" | "scheduler" | "chat";
    }
  | {
      source: "draft";
      definition: Record<string, unknown>;
      name?: string;
      input?: unknown;
      request_source?: "api" | "cli" | "mcp" | "webhook" | "tool-chain" | "scheduler" | "chat";
    }
  | {
      source: "step";
      step: Record<string, unknown>;
      workflow_slug?: string;
      input?: unknown;
      scope?: Record<string, unknown>;
      timeout_ms?: number;
      request_source?: "api" | "cli" | "mcp" | "webhook" | "tool-chain" | "scheduler" | "chat";
    };

/** Response shape of POST /v1/executions. Kept in sync with the engine's
 *  ExecutionRunResponse OpenAPI schema. Fields beyond `execution_id` and
 *  `status` are absent for async (queued) runs. */
export interface RunExecutionStepSummary {
  step_key: string;
  step_index: number;
  kind: string;
  status: string;
  duration_ms: number | null;
  retry_count: number;
  error: unknown;
  request_meta?: Record<string, unknown> | null;
}

export interface ConnectorResolutionSummary {
  step_key: string;
  connector_id: string;
  connector_slug: string;
  driver: string;
  requested_environment: "dev" | "prod";
  resolved_environment: "dev" | "prod";
  auth_method:
    | "none"
    | "bearer"
    | "header"
    | "query"
    | "basic"
    | "oauth2_static"
    | "oauth2_refreshed";
  base_url?: string | null;
}

export interface RunExecutionResponse {
  execution_id: string;
  status: string;
  output?: unknown;
  error?: unknown;
  steps?: RunExecutionStepSummary[];
  connector_resolutions?: ConnectorResolutionSummary[];
  warnings?: unknown[];
}

export class SkEngineError extends Error {
  readonly status: number;
  readonly code: string;
  readonly trace_id: string | null;
  readonly hint: string | null;
  readonly retry_after: number | null;
  readonly details: unknown;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    const parsed =
      typeof body === "object" && body !== null
        ? (body as {
            code?: unknown;
            message?: unknown;
            trace_id?: unknown;
            hint?: unknown;
            retry_after?: unknown;
            details?: unknown;
          })
        : null;
    const msg =
      parsed && typeof parsed.message === "string"
        ? parsed.message
        : typeof body === "string"
          ? body
          : `HTTP ${status}`;
    super(msg);
    this.name = "SkEngineError";
    this.status = status;
    this.code = parsed && typeof parsed.code === "string" ? parsed.code : `http_${status}`;
    this.trace_id =
      parsed && typeof parsed.trace_id === "string" && parsed.trace_id.length > 0
        ? parsed.trace_id
        : null;
    this.hint =
      parsed && typeof parsed.hint === "string" && parsed.hint.length > 0 ? parsed.hint : null;
    this.retry_after =
      parsed && typeof parsed.retry_after === "number" && Number.isFinite(parsed.retry_after)
        ? Math.max(0, Math.ceil(parsed.retry_after))
        : null;
    this.details = parsed?.details ?? null;
    this.body = body;
  }
}

export class SkTransportError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SkTransportError";
    this.cause = cause;
  }
}

export class EngineClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly tenant: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly debugMode: DebugMode;

  constructor(opts: ClientOptions) {
    this.base = opts.engine_url.replace(/\/+$/, "");
    this.apiKey = opts.api_key;
    this.tenant = opts.tenant ?? null;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.userAgent = opts.user_agent ?? "sk-cli/0.0.1";
    this.debugMode = opts.debug_mode ?? "command";
  }

  private headers(
    extra?: Record<string, string>,
    opts?: { traceId?: string },
  ): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": this.userAgent,
      ...extra,
    };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    if (this.tenant) h["x-subkit-tenant"] = this.tenant;
    if (opts?.traceId) h["x-sk-trace-id"] = opts.traceId;
    return h;
  }

  private newClientTraceId(): string {
    // Per-request trace id, sent outbound as `x-sk-trace-id`. The
    // engine's traceMiddleware accepts it (validated) and reuses it as
    // the request's trace_id, so the CLI's debug.log records and the
    // engine's structured logs share one id.
    const rand =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().replace(/-/g, "")
        : Math.random().toString(36).slice(2).padEnd(16, "0");
    return `cli-${rand.slice(0, 16)}`;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
    debugContext?: DebugCorrelationFields,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const qs = buildQuery(query);
    const url = `${this.base}${path}${qs}`;
    const traceId = debugContext?.trace_id ?? this.newClientTraceId();
    const init: RequestInit = {
      method,
      headers: this.headers(extraHeaders, { traceId }),
    };
    if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
    const startedAt = Date.now();
    const verbose = isDebugVerbose();
    const ctx = { ...this.debugContext(debugContext), trace_id: traceId };
    debugLog(
      "http.request",
      {
        method,
        path,
        url,
        tenant: this.tenant,
        query: query ?? null,
        request_kind: "json",
        ...(verbose
          ? {
              request_headers: normalizeHeaders(init.headers),
              request_body: body ?? null,
            }
          : {}),
      },
      ctx,
    );
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (cause) {
      const duration_ms = Date.now() - startedAt;
      debugLog(
        "http.transport_error",
        {
          method,
          path,
          url,
          tenant: this.tenant,
          query: query ?? null,
          duration_ms,
          error: serializeDebugError(cause),
        },
        ctx,
      );
      throw new SkTransportError(cause);
    }
    const text = await res.text();
    const duration_ms = Date.now() - startedAt;
    const parsed = parseResponseBody(text);
    const trace_id = extractTraceId(res.headers);
    if (!res.ok) {
      debugLog(
        "http.response",
        {
          method,
          path,
          url,
          tenant: this.tenant,
          query: query ?? null,
          status: res.status,
          ok: res.ok,
          duration_ms,
          trace_id,
          ...(verbose
            ? {
                response_headers: normalizeHeaders(res.headers),
                response_body: parsed,
              }
            : {}),
        },
        { ...ctx, trace_id: ctx.trace_id ?? trace_id },
      );
      throw new SkEngineError(res.status, parsed);
    }
    debugLog(
      "http.response",
      {
        method,
        path,
        url,
        tenant: this.tenant,
        query: query ?? null,
        status: res.status,
        ok: res.ok,
        duration_ms,
        trace_id,
        ...(verbose
          ? {
              response_headers: normalizeHeaders(res.headers),
              response_body: parsed,
            }
          : {}),
      },
      { ...ctx, trace_id: ctx.trace_id ?? trace_id },
    );
    if (!text || res.status === 204) return undefined as T;
    return parsed as T;
  }

  async stream(
    path: string,
    query?: Record<string, string | number | undefined>,
    debugContext?: DebugCorrelationFields,
  ): Promise<Response> {
    const qs = buildQuery(query);
    const url = `${this.base}${path}${qs}`;
    const traceId = debugContext?.trace_id ?? this.newClientTraceId();
    const headers = this.headers({ accept: "text/event-stream" }, { traceId });
    const verbose = isDebugVerbose();
    const ctx = { ...this.debugContext(debugContext), trace_id: traceId };
    debugLog(
      "http.request",
      {
        method: "GET",
        path,
        url,
        tenant: this.tenant,
        query: query ?? null,
        request_kind: "sse",
        ...(verbose ? { request_headers: normalizeHeaders(headers), request_body: null } : {}),
      },
      ctx,
    );
    try {
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers,
      });
      const trace_id = extractTraceId(res.headers);
      const error_body =
        verbose && !res.ok
          ? await res
              .clone()
              .text()
              .catch(() => null)
          : null;
      debugLog(
        "sse.open",
        {
          path,
          url,
          tenant: this.tenant,
          query: query ?? null,
          status: res.status,
          ok: res.ok,
          trace_id,
          ...(verbose
            ? {
                response_headers: normalizeHeaders(res.headers),
                response_body: error_body ? parseResponseBody(error_body) : null,
              }
            : {}),
        },
        { ...ctx, trace_id: ctx.trace_id ?? trace_id },
      );
      return res;
    } catch (cause) {
      debugLog(
        "sse.transport_error",
        {
          path,
          url,
          tenant: this.tenant,
          query: query ?? null,
          error: serializeDebugError(cause),
        },
        ctx,
      );
      throw new SkTransportError(cause);
    }
  }

  /**
   * POST a JSON body and consume an SSE response. Used by the
   * conversations create+append routes when the client wants live
   * progress frames. The engine content-negotiates: callers that send
   * `Accept: text/event-stream` get a stream; everyone else still gets
   * the buffered JSON outcome.
   */
  async streamPost(
    path: string,
    body: unknown,
    debugContext?: DebugCorrelationFields,
  ): Promise<Response> {
    const url = `${this.base}${path}`;
    const traceId = debugContext?.trace_id ?? this.newClientTraceId();
    const headers = this.headers({ accept: "text/event-stream" }, { traceId });
    const verbose = isDebugVerbose();
    const ctx = { ...this.debugContext(debugContext), trace_id: traceId };
    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    };
    debugLog(
      "http.request",
      {
        method: "POST",
        path,
        url,
        tenant: this.tenant,
        query: null,
        request_kind: "sse",
        ...(verbose
          ? { request_headers: normalizeHeaders(init.headers), request_body: body ?? null }
          : {}),
      },
      ctx,
    );
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (cause) {
      debugLog(
        "sse.transport_error",
        {
          path,
          url,
          tenant: this.tenant,
          query: null,
          error: serializeDebugError(cause),
        },
        ctx,
      );
      throw new SkTransportError(cause);
    }
    const trace_id = extractTraceId(res.headers);
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      const parsed = parseResponseBody(errBody);
      debugLog(
        "http.response",
        {
          method: "POST",
          path,
          url,
          tenant: this.tenant,
          query: null,
          status: res.status,
          ok: false,
          duration_ms: 0,
          trace_id,
          ...(verbose
            ? { response_headers: normalizeHeaders(res.headers), response_body: parsed }
            : {}),
        },
        { ...ctx, trace_id: ctx.trace_id ?? trace_id },
      );
      throw new SkEngineError(res.status, parsed);
    }
    debugLog(
      "sse.open",
      {
        path,
        url,
        tenant: this.tenant,
        query: null,
        status: res.status,
        ok: res.ok,
        trace_id,
        ...(verbose ? { response_headers: normalizeHeaders(res.headers) } : {}),
      },
      { ...ctx, trace_id: ctx.trace_id ?? trace_id },
    );
    return res;
  }

  // --------------------------- Health + Health-like ---------------------------
  health(): Promise<{
    status: string;
    db_connected: boolean;
    version?: string;
    uptime_seconds?: number;
  }> {
    return this.request("GET", "/v1/health");
  }

  // --------------------------- Version diagnostics ---------------------------
  /**
   * Engine version + update + schema-drift posture. Backed by
   * `/v1/diagnostics/version`, which requires `audit:read`. The
   * public `/v1/health` deliberately omits these fields so the engine
   * does not leak operational posture to unauthenticated callers.
   */
  diagnosticsVersion(): Promise<{
    engine_version: string;
    latest_version?: string;
    update_available: boolean;
    schema_drift: boolean;
    embedded_migrations_count: number;
  }> {
    return this.request("GET", "/v1/diagnostics/version");
  }

  // --------------------------- Drift diagnostics ---------------------------
  /**
   * Detailed schema-drift report. Backed by `/v1/diagnostics/drift`,
   * which requires `audit:read`. Surfaces the rows in
   * `drizzle.__drizzle_migrations` that are unknown to the engine
   * binary and the embedded migrations whose hash isn't in the DB
   * (informational — the boot path applies these on the same boot).
   */
  driftReport(): Promise<{
    engine_version: string;
    embedded_migration_count: number;
    db_migration_count: number;
    unknown_in_db: Array<{ row_id: number; hash: string; created_at: number | null }>;
    missing_in_db: Array<{ idx: number; tag: string; hash: string }>;
  }> {
    return this.request("GET", DIAGNOSTICS_DRIFT_PATH);
  }

  // --------------------------- Engine log tail ---------------------------
  /**
   * Pull a window of the engine's in-memory log ring buffer. Returns
   * raw JSON-line entries (each already structured with module / action
   * / msg). Backed by `/v1/diagnostics/logs?since=<unix_ms>&limit=<n>`,
   * which requires `audit:read`.
   */
  logsTailWindow(opts: {
    since_ms?: number;
    limit?: number;
    module?: string;
    action?: string;
    level?: string;
  }): Promise<{
    entries: Array<{
      ts: number;
      level: string;
      module?: string;
      action?: string;
      msg?: string;
      fields?: Record<string, unknown>;
    }>;
    next_since_ms: number;
    capacity: number;
    size: number;
  }> {
    const params = new URLSearchParams();
    if (typeof opts.since_ms === "number") params.set("since", String(opts.since_ms));
    if (typeof opts.limit === "number") params.set("limit", String(opts.limit));
    if (opts.module) params.set("module", opts.module);
    if (opts.action) params.set("action", opts.action);
    if (opts.level) params.set("level", opts.level);
    const qs = params.toString();
    return this.request("GET", `${DIAGNOSTICS_LOG_TAIL_PATH}${qs ? `?${qs}` : ""}`);
  }

  /**
   * Returns the absolute URL the SSE stream lives at. The caller wires
   * up its own `EventSource`/fetch-stream because each consumer
   * (Ink REPL, headless CLI tail) has different lifetime semantics.
   * Bearer auth must be added by the caller.
   */
  logsTailStreamUrl(opts: {
    since_ms?: number;
    module?: string;
    action?: string;
    level?: string;
  }): string {
    const params = new URLSearchParams();
    if (typeof opts.since_ms === "number") params.set("since", String(opts.since_ms));
    if (opts.module) params.set("module", opts.module);
    if (opts.action) params.set("action", opts.action);
    if (opts.level) params.set("level", opts.level);
    const qs = params.toString();
    return `${this.base}${DIAGNOSTICS_LOG_STREAM_PATH}${qs ? `?${qs}` : ""}`;
  }

  /**
   * Subscribe to the tenant-scoped event stream filtered to
   * `connector.oauth.callback_succeeded` events. When the user
   * completes an OAuth authorization in their browser, the engine
   * persists the credential and emits an event on the `connector.oauth`
   * channel; this helper consumes that stream and invokes
   * `onSucceeded` the first time a payload matching `connectorId`
   * arrives.
   *
   * Used by the REPL to auto-resume the conversation after
   * `authenticate_oauth` instead of waiting for the operator to type
   * "done" — plan/read-sk-synthetic-wirth.md Fix #1.
   *
   * Auto-closes the SSE connection after one match. The caller can
   * also abort via the returned `cancel()` or by aborting the supplied
   * `signal`. Filters are applied server-side via query params, so
   * cross-tenant events never reach the client.
   */
  async subscribeConnectorOAuthCallback(opts: {
    connectorId: string;
    signal?: AbortSignal;
    onSucceeded: (payload: {
      connector_id: string;
      connector_slug: string;
      has_refresh_token: boolean;
    }) => void;
  }): Promise<{ cancel: () => void }> {
    const url = `${this.base}/v1/events/stream?channel=connector.oauth&type=connector.oauth.callback_succeeded`;
    const ac = new AbortController();
    // Compose with the caller-supplied signal so either side can abort.
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener("abort", () => ac.abort(), { once: true });
    }
    const cancel = (): void => {
      if (!ac.signal.aborted) ac.abort();
    };
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: this.headers({ accept: "text/event-stream" }),
        signal: ac.signal,
      });
    } catch (err) {
      throw new SkTransportError(err);
    }
    if (!res.ok || !res.body) {
      cancel();
      throw new SkTransportError(new Error(`oauth events stream returned HTTP ${res.status}`));
    }
    // Consume in background — caller awaits `cancel()` indirectly via
    // `onSucceeded` or signal. The reader loop self-terminates on
    // first match or on abort.
    void (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        // Replay guard: `/v1/events/stream` replays the last 50 rows
        // on open (without Last-Event-ID). If the connector has been
        // OAuth'd before, a prior `connector.oauth.callback_succeeded`
        // for the same connector_id is in that replay — and would
        // auto-confirm the CURRENT elicitation before the operator
        // even finishes the new browser dance. The server announces
        // the live cutover with a `hello` event after the replay; we
        // ignore every payload-frame until that marker arrives.
        let live = false;
        while (!ac.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const block of frames) {
            if (!block.trim()) continue;
            if (block.startsWith(":")) continue; // heartbeat
            const lines = block.split("\n");
            const eventLine = lines.find((l) => l.startsWith("event: "));
            const dataLine = lines.find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            // The `hello` frame flips us from replay-discard mode into
            // live-event mode. Skip the frame itself but mark `live`.
            if (eventLine && eventLine.slice("event: ".length).trim() === "hello") {
              live = true;
              continue;
            }
            // Pre-hello frames are replay. Drop them — even if they
            // match the connector_id filter, they represent a PAST
            // OAuth completion, not the one the operator is doing now.
            if (!live) continue;
            try {
              const payload = JSON.parse(dataLine.slice("data: ".length)) as {
                connector_id?: unknown;
                connector_slug?: unknown;
                has_refresh_token?: unknown;
              };
              if (
                typeof payload.connector_id === "string" &&
                payload.connector_id === opts.connectorId &&
                typeof payload.connector_slug === "string" &&
                typeof payload.has_refresh_token === "boolean"
              ) {
                opts.onSucceeded({
                  connector_id: payload.connector_id,
                  connector_slug: payload.connector_slug,
                  has_refresh_token: payload.has_refresh_token,
                });
                cancel();
                return;
              }
            } catch {
              // Malformed frame — skip rather than abort. The next
              // valid frame may still match.
            }
          }
        }
      } catch {
        // Reader threw mid-stream (network drop, server restart, abort).
        // Caller's `signal` or independent timeout decides whether to
        // retry; we never retry transparently because that would mask
        // the failure from the operator.
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Reader was already released by the consumer loop; safe to swallow.
        }
      }
    })();
    return { cancel };
  }

  // --------------------------- Status snapshot ---------------------------
  /**
   * Composite status snapshot used by the Ink status-line ticker and the
   * `/status` pane. One round-trip instead of fanning out to /connectors
   * + /skills + /usage. Tenant-scoped by the engine.
   */
  statusSummary(): Promise<StatusSummary> {
    return this.request("GET", "/v1/status");
  }

  // --------------------------- Runtime stats (#160) ---------------------------
  // Tenant-scoped, time-bucketed read-only aggregates. Gated by the
  // `stats:read` permission server-side. Multi-value filters are passed
  // as comma-joined strings; the engine's CsvOrArray schema splits them.
  // Wire shape stays snake_case to match the OpenAPI surface.
  statsExecutions(query: StatsQuery): Promise<StatsExecutionsResponse> {
    return this.request("GET", "/v1/stats/executions", undefined, query);
  }
  statsConnectors(query: StatsQuery): Promise<StatsAuditResponse> {
    return this.request("GET", "/v1/stats/connectors", undefined, query);
  }
  statsEvents(query: StatsQuery): Promise<StatsAuditResponse> {
    return this.request("GET", "/v1/stats/events", undefined, query);
  }
  statsLlm(query: StatsQuery): Promise<StatsLlmResponse> {
    return this.request("GET", "/v1/stats/llm", undefined, query);
  }

  // --------------------------- Workflow versions ---------------------------
  /** List committed versions of a workflow (newest first). */
  listWorkflowVersions(workflowId: string): Promise<{
    items: Array<{ id: string; version: number; note: string | null; created_at: string }>;
  }> {
    return this.request("GET", `/v1/workflows/${encodeURIComponent(workflowId)}/history`);
  }
  /** Restore a prior workflow version as a new current version. */
  restoreWorkflowVersion(
    workflowId: string,
    version: number,
  ): Promise<{ id: string; current_version_id: string; version: number }> {
    return this.request(
      "POST",
      `/v1/workflows/${encodeURIComponent(workflowId)}/restore/${version}`,
    );
  }

  // --------------------------- RBAC probe ---------------------------
  /**
   * Probe whether the caller (or a specified principal id) holds a
   * permission. Used by the persona resolver + slash-command filter.
   */
  rbacCan(body: {
    principal_id: string;
    permission: string;
    resource?: { type: string; id: string };
  }): Promise<{ allow: boolean; source: string | null; reason: string | null }> {
    return this.request("POST", "/v1/rbac/can", body);
  }

  // --------------------------- Identity ---------------------------
  whoami(): Promise<{
    id: string;
    kind: "user" | "system_account";
    tenant_id: string;
    tenant_slug: string | null;
    email: string | null;
    role_name: string | null;
    provider: string;
  }> {
    return this.request("GET", "/v1/identity/whoami");
  }

  /**
   * Composite startup payload — replaces the per-permission rbac:can
   * fan-out the CLI used to issue at session start. Returns the
   * authenticated principal's whoami snapshot, the precomputed allow-set
   * for the well-known UX-gating permissions, the tenant snapshot, and
   * the most recent owned conversations.
   */
  skBootstrap(): Promise<components["schemas"]["SkBootstrap"]> {
    // Return type is the generated OpenAPI schema — single source of
    // truth shared with `apps/sk/src/lib/bootstrap.ts`. Replaces a
    // 19-line hand-rolled inline type that the previous review (R4-W1
    // / R4-S5) flagged as a typo-drift hazard.
    return this.request("GET", "/v1/sk/bootstrap");
  }

  // --------------------------- Conversations ---------------------------
  listConversations(
    query: { status?: string; owner?: "me"; limit?: number; offset?: number } = {},
  ): Promise<{ items: ConversationSummary[] }> {
    return this.request("GET", "/v1/conversations", undefined, query);
  }
  createConversation(
    body: {
      initial_message?: string;
      connector_id?: string;
      workflow_id?: string;
      memory?: string;
      model?: string;
      title?: string;
      permission_mode?: "auto" | "ask" | "plan" | "yolo";
    },
    debugContext?: DebugCorrelationFields,
  ): Promise<ConversationRunOutcome> {
    return this.request("POST", "/v1/conversations", body, undefined, debugContext);
  }
  /**
   * Streaming variant of createConversation. Returns the live SSE
   * response — frames must be consumed via `readSse`. The terminal
   * `outcome` event carries the conversation row + status that
   * `createConversation` returns in its JSON body; `events[]` is
   * NOT repeated in `outcome` (everything already streamed live).
   */
  createConversationStream(
    body: {
      initial_message?: string;
      connector_id?: string;
      workflow_id?: string;
      memory?: string;
      model?: string;
      title?: string;
      permission_mode?: "auto" | "ask" | "plan" | "yolo";
    },
    debugContext?: DebugCorrelationFields,
  ): Promise<Response> {
    return this.streamPost("/v1/conversations", body, debugContext);
  }
  getConversation(id: string): Promise<ConversationDetail> {
    return this.request("GET", `/v1/conversations/${id}`);
  }
  appendConversationMessage(
    id: string,
    body: {
      message: string;
      memory?: string;
      permission_mode?: "auto" | "ask" | "plan" | "yolo";
      /** Client-side opt-out for the next-message preview frame. */
      client_suppress?: boolean;
    },
    debugContext?: DebugCorrelationFields,
  ): Promise<ConversationRunOutcome> {
    return this.request("POST", `/v1/conversations/${id}/messages`, body, undefined, debugContext);
  }
  /**
   * Record an accept / dismiss / typed-over outcome for a suggestion.
   * Fire-and-forget — the engine increments a metric and returns
   * `{ ok: true }`. Errors are routed to the `debugLog` channel only
   * (a 5xx storm on this telemetry endpoint must not affect the
   * primary chat flow), so dev / on-call can still observe breakage
   * when `SK_DEBUG=1` without leaking it to the operator.
   */
  async submitSuggestionFeedback(
    conversationId: string,
    body: {
      accepted: boolean;
      source: "right-arrow" | "tab" | "typed-over" | "dismissed";
    },
  ): Promise<void> {
    try {
      await this.request("POST", `/v1/conversations/${conversationId}/suggest-next/feedback`, body);
    } catch (error) {
      debugLog(
        "suggest_next.feedback_failed",
        {
          conversationId,
          source: body.source,
          accepted: body.accepted,
          error: error instanceof Error ? error.message : String(error),
        },
        {},
      );
    }
  }
  /** Streaming variant of appendConversationMessage. See
   *  `createConversationStream` for terminal-event semantics. */
  appendConversationMessageStream(
    id: string,
    body: {
      message: string;
      memory?: string;
      permission_mode?: "auto" | "ask" | "plan" | "yolo";
      /** Client-side opt-out for the next-message preview frame. */
      client_suppress?: boolean;
    },
    debugContext?: DebugCorrelationFields,
  ): Promise<Response> {
    return this.streamPost(`/v1/conversations/${id}/messages`, body, debugContext);
  }
  patchConversation(
    id: string,
    body: { model?: string | null; title?: string | null },
  ): Promise<ConversationSummary> {
    return this.request("PATCH", `/v1/conversations/${id}`, body);
  }
  /**
   * Fork a conversation at a specific message id. Creates a new
   * conversation copying messages up to and including the anchor.
   *
   * The response is parsed through a Zod schema rather than trusted
   * by TS shape alone, matching the schema-validation direction the
   * rest of the engine-client surface is moving toward.
   */
  async forkConversationFromMessage(
    id: string,
    message_id: string,
  ): Promise<{
    conversation: ConversationSummary;
    source_conversation_id: string;
    anchor_message_id: string;
    copied_message_count: number;
    truncated: boolean;
  }> {
    const raw = await this.request<unknown>(
      "POST",
      `/v1/conversations/${encodeURIComponent(id)}/fork-from-message/${encodeURIComponent(
        message_id,
      )}`,
    );
    return ForkResponseSchema.parse(raw) as unknown as {
      conversation: ConversationSummary;
      source_conversation_id: string;
      anchor_message_id: string;
      copied_message_count: number;
      truncated: boolean;
    };
  }
  compactConversation(
    id: string,
    body: { keep_last?: number } = {},
  ): Promise<{
    conversation: ConversationSummary;
    summary: string;
    messages_collapsed: number;
  }> {
    return this.request("POST", `/v1/conversations/${id}/compact`, body);
  }
  /** Streaming variant of respondElicitation. Returns the raw SSE
   *  Response so the caller can read TurnEvents in real time exactly
   *  like `createConversationStream` / `appendConversationMessageStream`.
   *  Pre-fix the elicit-resume path was JSON-only — the CLI saw nothing
   *  for the entire 1–2 minute resumed turn, then everything at once. */
  respondElicitationStream(
    conversationId: string,
    elicitationId: string,
    output: unknown,
    reason?: string,
    debugContext?: DebugCorrelationFields,
    permission_mode?: "auto" | "ask" | "plan" | "yolo",
  ): Promise<Response> {
    const body: Record<string, unknown> = { output };
    if (reason) body.reason = reason;
    if (permission_mode) body.permission_mode = permission_mode;
    return this.streamPost(
      `/v1/conversations/${conversationId}/elicitations/${elicitationId}/respond`,
      body,
      debugContext,
    );
  }

  async respondElicitation(
    conversationId: string,
    elicitationId: string,
    output: unknown,
    reason?: string,
    debugContext?: DebugCorrelationFields,
    permission_mode?: "auto" | "ask" | "plan" | "yolo",
  ): Promise<ConversationRunOutcome> {
    const path = `/v1/conversations/${conversationId}/elicitations/${elicitationId}/respond`;
    const body: Record<string, unknown> = { output };
    if (reason) body.reason = reason;
    if (permission_mode) body.permission_mode = permission_mode;
    try {
      return await this.request<ConversationRunOutcome>(
        "POST",
        path,
        body,
        undefined,
        debugContext,
      );
    } catch (err) {
      // Long LLM turns (the engine streams text + multiple tool calls
      // server-side) can exceed bun-fetch's keep-alive window, dropping
      // the response side of the socket while the engine keeps writing.
      // The engine persists turn state at every step, so we recover by
      // (a) trying the POST once more — the engine's elicitation
      // dedup raises 409 elicitation_already_resolved if the first
      // POST landed, which is the explicit "your response was applied"
      // signal — and (b) on 409, replaying from the conversation
      // detail. This keeps the user out of the duplicate-prompt
      // workaround that session f00b8d1c walked into.
      if (!isTransientSocketDrop(err)) throw err;
      debugLog(
        "http.transport_recovery",
        {
          path,
          strategy: "respond_elicitation_retry",
          attempt: 1,
        },
        { ...this.debugContext(debugContext), conversation_id: conversationId },
      );
      await sleepMs(2000);
      try {
        return await this.request<ConversationRunOutcome>(
          "POST",
          path,
          body,
          undefined,
          debugContext,
        );
      } catch (retryErr) {
        if (
          retryErr instanceof Error &&
          retryErr.name === "SkEngineError" &&
          (retryErr as SkEngineError).code === "elicitation_already_resolved"
        ) {
          // First POST already landed; the elicitation row moved on.
          // Pull the latest detail and synthesize a recovered outcome.
          // No SSE events to replay — the UI prints the recovery
          // hint and re-renders messages/tool_calls from detail.
          debugLog(
            "http.transport_recovery",
            {
              path,
              strategy: "respond_elicitation_replay_via_detail",
              elicitation_id: elicitationId,
            },
            { ...this.debugContext(debugContext), conversation_id: conversationId },
          );
          const detail = await this.getConversation(conversationId);
          return synthesizeRecoveredOutcome(detail);
        }
        throw retryErr;
      }
    }
  }
  cancelConversation(id: string): Promise<unknown> {
    return this.request("POST", `/v1/conversations/${id}/cancel`);
  }
  getConversationContextSnapshot(id: string): Promise<ConversationContextSnapshot> {
    return this.request("GET", `/v1/conversations/${id}/context-snapshot`);
  }
  streamConversation(id: string, debugContext?: DebugCorrelationFields): Promise<Response> {
    return this.stream(`/v1/conversations/${id}/stream`, undefined, debugContext);
  }
  // Per-tool execution-mode overrides (Bug RR). Empty `{policies}`
  // GETs the current map; PUT merges the supplied entries (a `null`
  // value clears that tool's override).
  getConversationToolPolicies(id: string): Promise<{
    policies: Record<string, "no_confirm" | "confirm_before_execution" | "confirm_after_execution">;
  }> {
    return this.request("GET", `/v1/conversations/${id}/tool-policies`);
  }
  setConversationToolPolicies(
    id: string,
    policies: Record<
      string,
      "no_confirm" | "confirm_before_execution" | "confirm_after_execution" | null
    >,
  ): Promise<{
    policies: Record<string, "no_confirm" | "confirm_before_execution" | "confirm_after_execution">;
  }> {
    return this.request("PUT", `/v1/conversations/${id}/tool-policies`, { policies });
  }

  // --------------------------- Skills ---------------------------
  listSkills(
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Array<{ id: string; title: string; scope: string }> }> {
    return this.request("GET", "/v1/skills", undefined, query);
  }

  // --------------------------- MCP catalog ---------------------------
  listMcpPrompts(): Promise<{
    items: Array<{ name: string; description: string | null; scope: string; skill_id: string }>;
  }> {
    return this.request("GET", "/v1/mcp/prompts");
  }
  listMcpResources(): Promise<{
    items: Array<{
      uri: string;
      name: string;
      description: string | null;
      mime_type: string | null;
    }>;
  }> {
    return this.request("GET", "/v1/mcp/resources");
  }
  listMcpTools(): Promise<{
    items: Array<{ name: string; description: string; input_shape: unknown }>;
  }> {
    return this.request("GET", "/v1/mcp/tools");
  }

  // --------------------------- Audit (admin only) ---------------------------
  tailAuditLog(
    query: { actor_id?: string; action?: string; limit?: number } = {},
  ): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request("GET", "/v1/audit-log", undefined, query);
  }

  // --------------------- Diagnostics (engine error ring) --------------------
  tailEngineErrors(
    query: { limit?: number; since?: string; trace_id?: string } = {},
  ): Promise<{ items: EngineErrorEntry[]; total_buffered: number }> {
    return this.request("GET", "/v1/diagnostics/errors", undefined, query);
  }

  setupValidation(): Promise<SetupValidationResponse> {
    return this.request("GET", "/v1/diagnostics/setup");
  }

  // --------------------------- Settings -----------------------------------
  listSettings(opts: { tenant?: string } = {}): Promise<SettingsListResponse> {
    const qs = opts.tenant ? `?tenant=${encodeURIComponent(opts.tenant)}` : "";
    return this.request("GET", `/v1/settings${qs}`);
  }

  getSetting(path: string, opts: { tenant?: string } = {}): Promise<SettingLeafEntry> {
    const qs = opts.tenant ? `?tenant=${encodeURIComponent(opts.tenant)}` : "";
    return this.request("GET", `/v1/settings/${encodeURIComponent(path)}${qs}`);
  }

  setSetting(
    path: string,
    value: unknown,
    opts: { tenant?: string; force?: boolean } = {},
  ): Promise<SettingPutResult> {
    const qs = opts.tenant ? `?tenant=${encodeURIComponent(opts.tenant)}` : "";
    const body: Record<string, unknown> = { value };
    if (opts.force) body.force = true;
    // Tag the audit row with audit_source=sk_cli so compliance review
    // can distinguish operator-driven settings writes from the
    // deploy-body bootstrap path. Header name + value come from
    // `@shared/audit-source` — same module the engine route boundary
    // (apps/engine/src/audit/audit-source.ts) imports from. A future
    // rename of either lands in one place and propagates here.
    return this.request(
      "PUT",
      `/v1/settings/${encodeURIComponent(path)}${qs}`,
      body,
      undefined,
      undefined,
      { [AUDIT_SOURCE_HEADER]: SK_CLI_AUDIT_SOURCE },
    );
  }

  getDiagnosticsLlm(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/diagnostics/llm");
  }

  // -------------------- Multipart helper --------------------
  private async requestForm<T = unknown>(
    method: string,
    path: string,
    form: FormData,
    debugContext?: DebugCorrelationFields,
  ): Promise<T> {
    const qs = "";
    const url = `${this.base}${path}${qs}`;
    // Omit content-type so the browser/bun sets it with boundary automatically.
    const h: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.userAgent,
    };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    if (this.tenant) h["x-subkit-tenant"] = this.tenant;
    const traceId = debugContext?.trace_id ?? this.newClientTraceId();
    h["x-sk-trace-id"] = traceId;
    const verbose = isDebugVerbose();
    const ctx = { ...this.debugContext(debugContext), trace_id: traceId };
    debugLog(
      "http.request",
      {
        method,
        path,
        url,
        tenant: this.tenant,
        query: null,
        request_kind: "form",
        ...(verbose
          ? {
              request_headers: normalizeHeaders(h),
              request_body: await serializeFormData(form),
            }
          : {}),
      },
      ctx,
    );
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers: h, body: form });
    } catch (cause) {
      debugLog(
        "http.transport_error",
        {
          method,
          path,
          url,
          tenant: this.tenant,
          query: null,
          error: serializeDebugError(cause),
        },
        ctx,
      );
      throw new SkTransportError(cause);
    }
    const text = await res.text();
    const parsed = parseResponseBody(text);
    const trace_id = extractTraceId(res.headers);
    if (!res.ok) {
      debugLog(
        "http.response",
        {
          method,
          path,
          url,
          tenant: this.tenant,
          query: null,
          status: res.status,
          ok: res.ok,
          trace_id,
          ...(verbose
            ? {
                response_headers: normalizeHeaders(res.headers),
                response_body: parsed,
              }
            : {}),
        },
        { ...ctx, trace_id: ctx.trace_id ?? trace_id },
      );
      throw new SkEngineError(res.status, parsed);
    }
    debugLog(
      "http.response",
      {
        method,
        path,
        url,
        tenant: this.tenant,
        query: null,
        status: res.status,
        ok: res.ok,
        trace_id,
        ...(verbose
          ? {
              response_headers: normalizeHeaders(res.headers),
              response_body: parsed,
            }
          : {}),
      },
      { ...ctx, trace_id: ctx.trace_id ?? trace_id },
    );
    if (!text || res.status === 204) return undefined as T;
    return parsed as T;
  }

  // -------------------- Files --------------------
  // Public file types — the wire shape matches
  // `apps/engine/src/api/files-schemas.ts`. We re-declare here rather
  // than reach into the engine package because the sk CLI is a separate
  // build with its own typecheck graph and the engine's Zod schemas
  // pull in the Hono runtime. The shape is verified by the engine's
  // unit tests; drift would surface as a Zod parse error at the route
  // boundary.

  /** Inline upload — wire shape of `POST /v1/files/inline`. */
  async uploadInline(file: {
    filename: string;
    content_type?: string;
    content_base64: string;
  }): Promise<FileWire> {
    const raw = await this.request<unknown>("POST", "/v1/files/inline", file);
    return FileWireSchema.parse(raw);
  }

  /** Batch-create — issue presigned PUT URLs for files >5 MB. */
  async batchCreateFiles(req: BatchCreateRequest): Promise<BatchCreateResponse> {
    const raw = await this.request<unknown>("POST", "/v1/files/batch-create", req);
    return BatchCreateResponseSchema.parse(raw);
  }

  /** PUT bytes to a presigned URL with progress callback. The URL is
   *  treated as absolute when it carries a scheme, relative-to-engine
   *  otherwise — the local-disk presign sink at
   *  `/v1/files/{id}/upload` returns a relative path so the CLI can
   *  swap engine bases between profiles without re-presigning. */
  async putToPresignedUrl(
    url: string,
    headers: Record<string, string>,
    body: BodyInit,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<void> {
    const isAbsolute = /^https?:\/\//i.test(url);
    const fullUrl = isAbsolute ? url : `${this.base}${url}`;
    // Bun's fetch supports `ReadableStream` bodies with `duplex: "half"`.
    // The progress callback fires from the byte-counter wrapper around
    // the stream, not from the response itself.
    const init: RequestInit & { duplex?: "half" } = {
      method: "PUT",
      headers,
      body,
    };
    if (body instanceof ReadableStream) init.duplex = "half";
    let res: Response;
    try {
      res = await this.fetchImpl(fullUrl, init);
    } catch (cause) {
      throw new SkTransportError(cause);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SkEngineError(res.status, parseResponseBody(text));
    }
    // Surface a final "complete" tick for callers wiring progress UIs.
    if (onProgress) onProgress(0, 0);
  }

  /** Finalize a presigned upload — server recomputes sha256 and
   *  rejects 422 on mismatch. */
  async finalizeFile(id: string, sha256: string): Promise<FileWire> {
    const raw = await this.request<unknown>(
      "POST",
      `/v1/files/${encodeURIComponent(id)}/finalize`,
      {
        sha256,
      },
    );
    return FileWireSchema.parse(raw);
  }

  /** Stream a file's bytes back from the engine. `range.start/end` are
   *  inclusive byte offsets; `range.end` omitted means "to the end". */
  async downloadFile(
    id: string,
    range?: { start: number; end?: number },
  ): Promise<{
    filename: string;
    content_type: string;
    size_bytes: number;
    stream: ReadableStream<Uint8Array>;
  }> {
    // First get metadata so the caller can show filename + size without
    // a second round-trip. The /content endpoint streams the bytes.
    const meta = await this.getFile(id);
    const headers: Record<string, string> = { accept: "*/*" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.tenant) headers["x-subkit-tenant"] = this.tenant;
    if (range) {
      const end = range.end !== undefined ? range.end : "";
      headers.range = `bytes=${range.start}-${end}`;
    }
    const url = `${this.base}/v1/files/${encodeURIComponent(id)}/content`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "GET", headers });
    } catch (cause) {
      throw new SkTransportError(cause);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SkEngineError(res.status, parseResponseBody(text));
    }
    if (!res.body) {
      throw new SkTransportError(new Error("download response has no body"));
    }
    return {
      filename: meta.filename,
      content_type: meta.content_type ?? "application/octet-stream",
      size_bytes: meta.size_bytes,
      stream: res.body,
    };
  }

  /** Paginated list. Cursor is opaque ISO timestamp issued by the engine. */
  async listFiles(
    query: { status?: string; linked_to?: string; cursor?: string; limit?: number } = {},
  ): Promise<{ items: FileWire[]; next_cursor?: string | null }> {
    const raw = await this.request<unknown>(
      "GET",
      "/v1/files",
      undefined,
      query as Record<string, string | number | undefined>,
    );
    const parsed = FileListResponseSchema.parse(raw);
    // `exactOptionalPropertyTypes`: project `next_cursor` to a value
    // that matches the declared `string | null` (not `| undefined`).
    return { items: parsed.items, next_cursor: parsed.next_cursor ?? null };
  }

  /** Get the file row. Returns soft-deleted rows during the cleanup
   *  cron's 7-day soft-delete grace so `sk files download` works
   *  briefly after `delete`. The list endpoint hides them. */
  async getFile(id: string): Promise<FileWire> {
    const raw = await this.request<unknown>("GET", `/v1/files/${encodeURIComponent(id)}`);
    return FileWireSchema.parse(raw);
  }

  /** Soft-delete. Subsequent `getFile` may still return during the
   *  in-flight grace window; the cleanup cron hard-deletes after 7d. */
  deleteFile(id: string): Promise<void> {
    return this.request<void>("DELETE", `/v1/files/${encodeURIComponent(id)}`);
  }

  /** Attach a file to an owning resource. Idempotent on
   *  `(resource_type, resource_id, slug)`. */
  async linkFile(
    file_id: string,
    link: {
      resource_type:
        | "conversation"
        | "knowledge_source"
        | "skill"
        | "connector"
        | "workflow_run"
        | "discovery_run";
      resource_id: string;
      slug?: string;
      role?: string;
    },
  ): Promise<FileLinkWire> {
    const raw = await this.request<unknown>(
      "POST",
      `/v1/files/${encodeURIComponent(file_id)}/links`,
      link,
    );
    return FileLinkWireSchema.parse(raw);
  }

  /** Aggregate counters. Cheap — bounded by tenant's row count. */
  async getFileStats(): Promise<FileStatsWire> {
    const raw = await this.request<unknown>("GET", "/v1/files/stats");
    return FileStatsWireSchema.parse(raw);
  }

  // -------------------- Workflows --------------------
  listWorkflows(
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/workflows", undefined, query);
  }
  getWorkflow(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/workflows/${encodeURIComponent(id)}`);
  }
  createWorkflow(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/workflows", body);
  }
  validateWorkflowDraft(
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; errors?: Array<{ path: string; message: string }> }> {
    return this.request("POST", "/v1/workflows/validate", body);
  }
  patchWorkflow(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/workflows/${encodeURIComponent(id)}`, body);
  }
  deleteWorkflow(id: string): Promise<void> {
    return this.request("DELETE", `/v1/workflows/${encodeURIComponent(id)}`);
  }
  // -------------------- Executions --------------------
  /** Run a saved workflow, a draft definition, or a single step via the
   *  unified `POST /v1/executions` surface. Mirrors the discriminated
   *  union accepted by the server. */
  runExecution(body: RunExecutionBody): Promise<RunExecutionResponse> {
    return this.request<RunExecutionResponse>(
      "POST",
      "/v1/executions",
      body as Record<string, unknown>,
    );
  }

  // -------------------- Connectors --------------------
  listConnectors(
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/connectors", undefined, query);
  }
  getConnector(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/connectors/${encodeURIComponent(id)}`);
  }
  createConnector(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/connectors", body);
  }
  patchConnector(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/connectors/${encodeURIComponent(id)}`, body);
  }
  deleteConnector(id: string): Promise<void> {
    return this.request("DELETE", `/v1/connectors/${encodeURIComponent(id)}`);
  }
  testConnector(id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/connectors/${encodeURIComponent(id)}/test`);
  }
  startConnectorOAuth(id: string): Promise<{ oauth_url: string }> {
    return this.request("POST", `/v1/connectors/${encodeURIComponent(id)}/oauth/start`);
  }
  ingestConnectorDocs(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/connectors/${encodeURIComponent(id)}/docs/ingest`, body);
  }
  listConnectorDocs(
    id: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", `/v1/connectors/${encodeURIComponent(id)}/docs`, undefined, query);
  }
  searchConnectorDocs(
    id: string,
    q: string,
    limit?: number,
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", `/v1/connectors/${encodeURIComponent(id)}/docs/search`, undefined, {
      q,
      limit,
    });
  }
  deleteConnectorDoc(connectorId: string, docId: string): Promise<void> {
    return this.request(
      "DELETE",
      `/v1/connectors/${encodeURIComponent(connectorId)}/docs/${encodeURIComponent(docId)}`,
    );
  }
  createCredential(
    connectorId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/connectors/${encodeURIComponent(connectorId)}/credentials`,
      body,
    );
  }
  rotateCredential(
    credentialId: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/credentials/${encodeURIComponent(credentialId)}/rotate`, body);
  }
  deleteCredential(credentialId: string): Promise<void> {
    return this.request("DELETE", `/v1/credentials/${encodeURIComponent(credentialId)}`);
  }

  // -------------------- Connector Templates --------------------
  listConnectorTemplates(
    query: Record<string, string | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/connector-templates", undefined, query);
  }
  createConnectorTemplate(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/connector-templates", body);
  }
  setConnectorTemplateOAuthCredentials(
    slug: string,
    body: { client_id: string; client_secret: string },
  ): Promise<{ id: string }> {
    return this.request(
      "POST",
      `/v1/connector-templates/${encodeURIComponent(slug)}/oauth-credentials`,
      body,
    );
  }
  deleteConnectorTemplate(id: string): Promise<void> {
    return this.request("DELETE", `/v1/connector-templates/${encodeURIComponent(id)}`);
  }
  listConnectorTemplateRecipes(slug: string): Promise<{
    template_slug: string;
    template_name: string;
    recipes: Record<string, unknown>[];
  }> {
    return this.request("GET", `/v1/connector-templates/${encodeURIComponent(slug)}/recipes`);
  }
  getConnectorTemplateRecipe(slug: string, recipeSlug: string): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/v1/connector-templates/${encodeURIComponent(slug)}/recipes/${encodeURIComponent(recipeSlug)}`,
    );
  }
  getRecipePack(vertical: string): Promise<{
    vertical: string;
    outcome: string;
    recipes: Array<Record<string, unknown>>;
  }> {
    return this.request("GET", `/v1/recipe-packs/${encodeURIComponent(vertical)}`);
  }
  createConnectorFromTemplate(
    slug: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/connectors/from-template/${encodeURIComponent(slug)}`, body);
  }

  // -------------------- Skills --------------------
  getSkill(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/skills/${encodeURIComponent(id)}`);
  }
  createSkill(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/skills", body);
  }
  patchSkill(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/skills/${encodeURIComponent(id)}`, body);
  }
  activateSkill(id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/skills/${encodeURIComponent(id)}/activate`);
  }
  archiveSkill(id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/skills/${encodeURIComponent(id)}/archive`);
  }
  deleteSkill(id: string): Promise<void> {
    return this.request("DELETE", `/v1/skills/${encodeURIComponent(id)}`);
  }

  // -------------------- Skill Candidates --------------------
  listSkillCandidates(
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/skill-candidates", undefined, query);
  }
  getSkillCandidate(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/skill-candidates/${encodeURIComponent(id)}`);
  }
  approveSkillCandidate(
    id: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/skill-candidates/${encodeURIComponent(id)}/approve`, body);
  }
  rejectSkillCandidate(
    id: string,
    body: { reason?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/skill-candidates/${encodeURIComponent(id)}/reject`, body);
  }

  // -------------------- Executions --------------------
  listExecutions(
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/executions", undefined, query);
  }
  getExecution(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/executions/${encodeURIComponent(id)}`);
  }
  executionSteps(id: string): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", `/v1/executions/${encodeURIComponent(id)}/steps`);
  }
  abortExecution(id: string): Promise<void> {
    return this.request("POST", `/v1/executions/${encodeURIComponent(id)}/abort`);
  }
  streamExecution(id: string): Promise<Response> {
    return this.stream(`/v1/executions/${encodeURIComponent(id)}/stream`);
  }

  // -------------------- Patch Candidates --------------------
  listPatchCandidates(
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/patch-candidates", undefined, query);
  }
  getPatchCandidate(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/patch-candidates/${encodeURIComponent(id)}`);
  }
  approvePatchCandidate(id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/patch-candidates/${encodeURIComponent(id)}/approve`);
  }
  rejectPatchCandidate(
    id: string,
    body: { reason?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/patch-candidates/${encodeURIComponent(id)}/reject`, body);
  }

  // -------------------- Self-Healing Scans --------------------
  triggerSelfHealingScan(
    body: { workflow_id?: string; connector_id?: string } = {},
    opts: { idempotencyKey?: string } = {},
  ): Promise<Record<string, unknown>> {
    const extraHeaders = opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {};
    return this.request("POST", "/v1/self-healing/scans", body, undefined, undefined, extraHeaders);
  }
  listSelfHealingScans(
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/self-healing/scans", undefined, query);
  }
  getSelfHealingScan(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/self-healing/scans/${encodeURIComponent(id)}`);
  }

  // -------------------- Inbound Hooks --------------------
  listHooksInbound(): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/webhooks/inbound");
  }
  getHookInbound(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/webhooks/inbound/${encodeURIComponent(id)}`);
  }
  createHookInbound(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/webhooks/inbound", body);
  }
  deleteHookInbound(id: string): Promise<void> {
    return this.request("DELETE", `/v1/webhooks/inbound/${encodeURIComponent(id)}`);
  }

  // -------------------- Subscriptions --------------------
  listSubscriptions(): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/subscriptions");
  }
  getSubscription(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/subscriptions/${encodeURIComponent(id)}`);
  }
  createSubscription(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/subscriptions", body);
  }
  patchSubscription(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/subscriptions/${encodeURIComponent(id)}`, body);
  }
  deleteSubscription(id: string): Promise<void> {
    return this.request("DELETE", `/v1/subscriptions/${encodeURIComponent(id)}`);
  }
  replaySubscriptionDelivery(id: string, deliveryId: string): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/subscriptions/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/replay`,
    );
  }

  // -------------------- Events --------------------
  listEvents(
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/events", undefined, query);
  }

  // -------------------- API Keys --------------------
  listApiKeys(): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/identity/api-keys");
  }
  issueApiKey(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/identity/api-keys", body);
  }
  rotateApiKey(id: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/identity/api-keys/${encodeURIComponent(id)}/rotate`, body);
  }
  revokeApiKey(id: string): Promise<void> {
    return this.request("DELETE", `/v1/identity/api-keys/${encodeURIComponent(id)}`);
  }

  // -------------------- Portal Tokens --------------------
  listPortalTokens(): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/identity/portal-tokens");
  }
  issuePortalToken(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/identity/portal-tokens", body);
  }
  revokePortalToken(id: string): Promise<void> {
    return this.request("DELETE", `/v1/identity/portal-tokens/${encodeURIComponent(id)}`);
  }

  // -------------------- Knowledge Sources --------------------
  listKnowledgeSources(
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/knowledge-sources", undefined, query);
  }
  searchKnowledge(
    q: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ hits: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/knowledge-sources/search", undefined, { q, ...query });
  }
  getKnowledgeSource(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/knowledge-sources/${encodeURIComponent(id)}`);
  }
  patchKnowledgeSource(
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/knowledge-sources/${encodeURIComponent(id)}`, body);
  }
  analyzeKnowledgeSource(
    id: string,
    body: { force?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/knowledge-sources/${encodeURIComponent(id)}/analyze`, body);
  }
  deleteKnowledgeSource(id: string): Promise<void> {
    return this.request("DELETE", `/v1/knowledge-sources/${encodeURIComponent(id)}`);
  }
  createKnowledgeSource(
    file: { name: string; content: Buffer | Uint8Array; mime_type: string },
    metadata: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([file.content as unknown as ArrayBuffer], { type: file.mime_type }),
      file.name,
    );
    form.append("metadata", JSON.stringify({ name: file.name, ...metadata }));
    return this.requestForm("POST", "/v1/knowledge-sources", form);
  }

  // -------------------- Discovery --------------------
  listDiscoveryRuns(
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/discovery", undefined, query);
  }
  getDiscoveryRun(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/discovery/${encodeURIComponent(id)}`);
  }
  listDiscoveryArtifacts(
    runId: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request(
      "GET",
      `/v1/discovery/${encodeURIComponent(runId)}/artifacts`,
      undefined,
      query,
    );
  }
  approveDiscoveryArtifact(id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/discovery/${encodeURIComponent(id)}/approve`);
  }
  rejectDiscoveryArtifact(
    id: string,
    body: { reason?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/discovery/${encodeURIComponent(id)}/reject`, body);
  }
  createDiscoveryRun(
    files: Array<{ name: string; content: Buffer | Uint8Array; mime_type: string }>,
    label?: string,
  ): Promise<Record<string, unknown>> {
    const form = new FormData();
    for (const f of files) {
      form.append(
        "files",
        new Blob([f.content as unknown as ArrayBuffer], { type: f.mime_type }),
        f.name,
      );
    }
    if (label) form.append("label", label);
    return this.requestForm("POST", "/v1/discovery", form);
  }

  // -------------------- RBAC Management --------------------
  listPermissions(): Promise<{ items: string[] }> {
    return this.request("GET", "/v1/rbac/permissions");
  }
  listRoles(
    query: Record<string, string | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/rbac/roles", undefined, query);
  }
  getRole(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/rbac/roles/${encodeURIComponent(id)}`);
  }
  createRole(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/rbac/roles", body);
  }
  patchRole(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/rbac/roles/${encodeURIComponent(id)}`, body);
  }
  deleteRole(id: string): Promise<void> {
    return this.request("DELETE", `/v1/rbac/roles/${encodeURIComponent(id)}`);
  }
  grantRolePermission(roleId: string, permission: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/rbac/roles/${encodeURIComponent(roleId)}/permissions`, {
      permission,
    });
  }
  revokeRolePermission(roleId: string, permission: string): Promise<void> {
    return this.request(
      "DELETE",
      `/v1/rbac/roles/${encodeURIComponent(roleId)}/permissions/${encodeURIComponent(permission)}`,
    );
  }
  assignUserRole(userId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/rbac/users/${encodeURIComponent(userId)}/role`, body);
  }
  listGrants(
    query: Record<string, string | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/rbac/grants", undefined, query);
  }
  createGrant(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/rbac/grants", body);
  }
  deleteGrant(id: string): Promise<void> {
    return this.request("DELETE", `/v1/rbac/grants/${encodeURIComponent(id)}`);
  }
  listGroups(): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/rbac/groups");
  }
  createGroup(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/rbac/groups", body);
  }
  patchGroup(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/rbac/groups/${encodeURIComponent(id)}`, body);
  }
  deleteGroup(id: string): Promise<void> {
    return this.request("DELETE", `/v1/rbac/groups/${encodeURIComponent(id)}`);
  }
  addGroupMember(groupId: string, userId: string): Promise<void> {
    return this.request(
      "POST",
      `/v1/rbac/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
    );
  }
  removeGroupMember(groupId: string, userId: string): Promise<void> {
    return this.request(
      "DELETE",
      `/v1/rbac/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
    );
  }
  assignGroupRole(groupId: string, roleId: string): Promise<void> {
    return this.request(
      "POST",
      `/v1/rbac/groups/${encodeURIComponent(groupId)}/roles/${encodeURIComponent(roleId)}`,
    );
  }
  removeGroupRole(groupId: string, roleId: string): Promise<void> {
    return this.request(
      "DELETE",
      `/v1/rbac/groups/${encodeURIComponent(groupId)}/roles/${encodeURIComponent(roleId)}`,
    );
  }

  // -------------------- Request Hooks --------------------
  listRequestHooks(): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/auth/request-hooks");
  }
  createRequestHook(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/auth/request-hooks", body);
  }
  patchRequestHook(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/auth/request-hooks/${encodeURIComponent(id)}`, body);
  }
  deleteRequestHook(id: string): Promise<void> {
    return this.request("DELETE", `/v1/auth/request-hooks/${encodeURIComponent(id)}`);
  }

  // -------------------- Audit Log (extended) --------------------
  queryAuditLog(
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[]; cursor?: string }> {
    return this.request("GET", "/v1/audit-log", undefined, query);
  }
  getAuditEvent(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/audit-log/${encodeURIComponent(id)}`);
  }
  exportAuditLog(query: Record<string, string | number | undefined> = {}): Promise<Response> {
    return this.stream("/v1/audit-log/export.ndjson", query);
  }

  // -------------------- AI --------------------
  extract(body: { sample: string; hint?: string }): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/ai/extract", body);
  }

  /** Upload a raw file body to `POST /v1/extract` — used by `sk extract`
   *  when the input is a binary office document (PDF/DOCX/XLSX/PPTX).
   *  Bypasses the JSON `request()` helper because the body is bytes, not
   *  a JSON-serialisable object. */
  async extractFile(args: {
    buffer: Uint8Array;
    contentType: string;
    filename?: string;
  }): Promise<Record<string, unknown>> {
    const traceId = this.newClientTraceId();
    const headers = this.headers(undefined, { traceId });
    headers["content-type"] = args.contentType;
    if (args.filename) headers["x-filename"] = args.filename;
    // fetch's typed BodyInit doesn't include Uint8Array on this
    // TypeScript target; widen via the underlying ArrayBuffer slice so
    // Bun and undici both accept the body without runtime conversion.
    const ab = args.buffer.buffer.slice(
      args.buffer.byteOffset,
      args.buffer.byteOffset + args.buffer.byteLength,
    ) as ArrayBuffer;
    const init: RequestInit = {
      method: "POST",
      headers,
      body: ab,
    };
    const res = await this.fetchImpl(`${this.base}/v1/extract`, init);
    const text = await res.text();
    const parsed = parseResponseBody(text);
    if (!res.ok) throw new SkEngineError(res.status, parsed);
    return (parsed ?? {}) as Record<string, unknown>;
  }

  // -------------------- Notifications --------------------
  listNotificationChannels(): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/notifications/channels");
  }
  createNotificationChannel(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/notifications/channels", body);
  }
  patchNotificationChannel(
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/notifications/channels/${encodeURIComponent(id)}`, body);
  }
  deleteNotificationChannel(id: string): Promise<void> {
    return this.request("DELETE", `/v1/notifications/channels/${encodeURIComponent(id)}`);
  }
  listNotificationRules(): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/notifications/rules");
  }
  createNotificationRule(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/notifications/rules", body);
  }
  patchNotificationRule(
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/notifications/rules/${encodeURIComponent(id)}`, body);
  }
  deleteNotificationRule(id: string): Promise<void> {
    return this.request("DELETE", `/v1/notifications/rules/${encodeURIComponent(id)}`);
  }
  listNotificationDeliveries(
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/notifications/deliveries", undefined, query);
  }
  getNotificationInbox(query: { since?: number; limit?: number } = {}): Promise<{
    items: Array<{
      id: number;
      severity: string;
      event_type: string;
      event_payload: unknown;
      created_at: string;
    }>;
    cursor: number;
  }> {
    return this.request("GET", "/v1/notifications/inbox", undefined, {
      since: query.since,
      limit: query.limit,
    });
  }
  ackNotificationInbox(up_to_cursor: number): Promise<{ acked: number }> {
    return this.request("POST", "/v1/notifications/inbox/ack", { up_to_cursor });
  }

  // -------------------- Identity: Users --------------------
  listIdentityUsers(
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/identity/users", undefined, query);
  }
  getIdentityUser(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/identity/users/${encodeURIComponent(id)}`);
  }
  patchIdentityUser(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/identity/users/${encodeURIComponent(id)}`, body);
  }
  deleteIdentityUser(id: string): Promise<void> {
    return this.request("DELETE", `/v1/identity/users/${encodeURIComponent(id)}`);
  }

  // -------------------- Identity: System Accounts --------------------
  listSystemAccounts(): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/identity/system-accounts");
  }
  createSystemAccount(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/identity/system-accounts", body);
  }
  deleteSystemAccount(id: string): Promise<void> {
    return this.request("DELETE", `/v1/identity/system-accounts/${encodeURIComponent(id)}`);
  }

  // -------------------- Identity: Tenants --------------------
  listIdentityTenants(
    query: Record<string, string | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/identity/tenants", undefined, query);
  }
  getIdentityTenant(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/identity/tenants/${encodeURIComponent(id)}`);
  }

  private debugContext(debugContext?: DebugCorrelationFields): DebugCorrelationFields {
    return { mode: this.debugMode, ...debugContext };
  }
}

export interface EngineErrorEntry {
  trace_id: string | null;
  ts: string;
  tenant_id: string | null;
  method: string;
  path: string;
  status: number;
  code: string;
  message: string;
  stack: string | null;
  bucket: "unhandled" | "llm_provider" | "llm_no_object" | "llm_timeout" | "llm_quota" | "http";
}

export interface SetupValidationIssue {
  id: string;
  severity: "blocker" | "warning";
  title: string;
  detail: string;
}

export interface SetupValidationValue {
  key: string;
  value: string | null;
  status_hint: string | null;
}

export interface SetupValidationSection {
  title: string;
  status: "ok" | "warn" | "blocked";
  issues: SetupValidationIssue[];
  recommendations: string[];
  values: SetupValidationValue[];
}

export interface SetupValidationResponse {
  overall_status: "ok" | "warn" | "blocked";
  summary_counts: {
    blockers: number;
    warnings: number;
    sections_blocked: number;
    sections_warn: number;
  };
  sections: {
    auth: SetupValidationSection;
    llm: SetupValidationSection;
    datastore: SetupValidationSection;
    storage: SetupValidationSection;
    crypto: SetupValidationSection;
    public_urls: SetupValidationSection;
  };
  issues: SetupValidationIssue[];
  recommendations: string[];
}

export type SettingSource = "override" | "tenant" | "global" | "default";

export interface SettingLeafMeta {
  source: SettingSource;
  scope: "global" | "tenant";
  sensitive: boolean;
  requiresRestart: boolean;
  description?: string;
  kind: string;
}

export interface SettingLeafEntry {
  path: string;
  value: unknown;
  meta: SettingLeafMeta;
}

export interface SettingsListResponse {
  items: SettingLeafEntry[];
  diagnostics: {
    pending_restart_keys: string[];
    override_keys: string[];
  };
}

export interface SettingPutResult {
  value: unknown;
  requiresRestart: boolean;
}

function parseResponseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeHeaders(
  headers?: HeadersInit | Record<string, string | undefined>,
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return headers.reduce<Record<string, string>>((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});
  }
  return Object.entries(headers).reduce<Record<string, string>>((acc, [key, value]) => {
    if (typeof value === "string") acc[key] = value;
    return acc;
  }, {});
}

async function serializeFormData(form: FormData): Promise<Array<Record<string, unknown>>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      entries.push({ name, kind: "text", value });
      continue;
    }
    const fileValue = value as Blob & { name?: string };
    const entry: Record<string, unknown> = {
      name,
      kind: "file",
      file: {
        name: fileValue.name ?? null,
        type: fileValue.type,
        size: fileValue.size,
      },
    };
    if (looksTextual(fileValue.type)) {
      try {
        entry.text = await fileValue.text();
      } catch {
        entry.text = "[unreadable]";
      }
    }
    entries.push(entry);
  }
  return entries;
}

function looksTextual(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("yaml")
  );
}

function buildQuery(params: Record<string, unknown> | undefined): string {
  if (!params) return "";
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    usp.set(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : "";
}

// ---------- Minimal response shapes ----------

export interface ConversationSummary {
  id: string;
  tenant_id: string;
  target_workflow_id: string | null;
  target_connector_id: string | null;
  status: string;
  owner_id: string | null;
  model: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  last_message_role?: string | null;
  last_message_excerpt?: string | null;
}

export interface ConversationRunOutcome {
  conversation: ConversationSummary;
  events: unknown[];
  status: string;
  committed_workflow_id?: string;
  pending_approval_id?: string;
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  messages: unknown[];
  tool_calls: unknown[];
  draft: unknown;
  approvals?: unknown[];
  resume_summary?: ResumeSummary | null;
}

export interface ResumeSummary {
  active_target: {
    kind: "connector" | "workflow" | "none";
    name: string | null;
    slug: string | null;
    id: string | null;
    environment: string | null;
  };
  stage: string;
  last_successful_probe: string | null;
  last_successful_preview: string | null;
  unsaved: boolean;
  pending_approval: {
    id: string;
    tool_name: string;
    summary: string;
  } | null;
  next_action: string;
  one_sentence: string;
}

export interface ConversationContextSnapshot {
  conversation_id: string;
  connector_id: string | null;
  workflow_id: string | null;
  draft_mode: string;
  authoring_mode: string | null;
  authoring_stage: string | null;
  draft_summary: {
    readiness: string;
    next_action: string | null;
    next_required_action: string | null;
    next_suggested_tool: string | null;
    missing_fields: string[];
    progress_label: string | null;
    lifecycle_state: string;
    blocked_by: string[];
  } | null;
  active_target: {
    kind: "connector" | "workflow" | "none";
    name: string | null;
    slug: string | null;
    id: string | null;
    environment: string | null;
    lifecycle_state: string;
  } | null;
  checkpoint_statuses: Array<{
    key: string;
    status: string;
    verified_at: string | null;
    verified_by_tool: string | null;
    ok: boolean | null;
    summary: string | null;
  }>;
  stale_checkpoints: string[];
  next_required_action: string | null;
  persisted_resources: Array<{
    kind: string;
    id: string;
    slug: string | null;
    name: string | null;
    version_id: string | null;
    version: number | null;
    environment: string | null;
    saved_at: string;
  }>;
  latest_execution: {
    execution_id: string;
    workflow_id: string | null;
    workflow_version_id: string | null;
    status: string;
    environment: string;
    warnings_count: number;
    recorded_at: string;
    diagnosis_available: boolean;
  } | null;
  latest_diagnosis: {
    execution_id: string;
    recorded_at: string;
    reason: string;
    warning_sources: Array<{ step_key: string; code: string; identifier: string | null }>;
    steps: Array<{
      step_key: string;
      kind: string;
      status: string;
      duration_ms: number | null;
      output_preview?: unknown;
      error?: unknown;
      request_meta?: unknown;
    }>;
  } | null;
  skills: {
    global: Array<{ id: string; title: string }>;
    connector: Array<{ id: string; title: string }>;
    workflow: Array<{ id: string; title: string }>;
    total: number;
  };
  messages: {
    total: number;
    last_role: string | null;
  };
  tool_calls_total: number;
  pending_elicitations: number;
  attachments: {
    total: number;
    items: Array<{ slug: string; filename: string | null; bytes: number | null }>;
  };
  latest_probe: {
    ok: boolean;
    summary: string | null;
    failure_code: string | null;
  } | null;
  latest_preview: {
    ok: boolean;
    summary: string | null;
    step_id: string | null;
  } | null;
  workflow_version: {
    workflow_id: string;
    current_version: number | null;
  } | null;
}

export interface StatusSummary {
  user: { id: string; email: string | null; kind: "user" | "system_account" };
  tenant: { id: string; slug: string | null };
  connectors_count: number;
  skills_count: number;
  tokens_today: number;
  tokens_month: number;
  monthly_budget_tokens: number | null;
  remaining_monthly_budget_tokens: number | null;
  version: string;
}
