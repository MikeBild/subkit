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

/**
 * S7 of PR #161 review (round 4): Zod schema for the fork-from-message
 * response so a server that breaks the shape (or a future engine that
 * adds an unknown field interpreted by the wrong path) is rejected at
 * the CLI boundary instead of smuggled through as TS-shape-only.
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
   * `/v1/diagnostics/version`, which requires `audit:read`. Issue #151
   * P0-1 moved these fields off the public `/v1/health` so the engine
   * stops leaking operational posture to unauthenticated callers.
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

  // --------------------------- Status snapshot ---------------------------
  /**
   * Composite status snapshot used by the Ink status-line ticker and the
   * `/status` pane. One round-trip instead of fanning out to /connectors
   * + /skills + /usage. Tenant-scoped by the engine.
   */
  statusSummary(): Promise<StatusSummary> {
    return this.request("GET", "/v1/status");
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
   * `{ ok: true }`. Errors are not surfaced to the user since the
   * primary flow has already completed.
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
    } catch {
      // Telemetry-only endpoint — never let it bubble.
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
   * G10 closure of #159 M10.
   *
   * S7 of PR #161 review (round 4): the response is parsed through a
   * Zod schema rather than trusted by TS shape alone. The other
   * engine-client methods will be migrated incrementally; the fork
   * route is the first one introduced post-`SkBootstrapPrefsSchema`
   * and matches that direction.
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
  ): Promise<{ items: Record<string, unknown>[] }> {
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
