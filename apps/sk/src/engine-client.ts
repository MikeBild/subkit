// Thin typed client over the subkit engine's REST API, scoped to the
// surfaces the `sk` end-user CLI needs. Hand-written rather than
// `hono/client` so the compiled binary stays tight — pulling the
// engine's `AppType` through Hono drags the entire server module
// graph in.
//
// Naming convention: wire-shape fields stay
// snake_case to match the engine's OpenAPI surface — `tenant_id`,
// `tenant_slug`, `retry_after`, `trace_id`. Local-only fields use
// camelCase. This means TS callers occasionally see `err.retry_after`
// next to `err.message` / `err.code`; the snake_case names are the
// authoritative wire shape and are deliberate.
//
// This module owns the client class and the shared transport plumbing
// (auth headers, trace ids, JSON / SSE / multipart request paths). The
// per-resource method groups live in `./engine-client/*.ts` — each
// exports a plain object of methods typed with an explicit
// `this: EngineClient` parameter, merged into the class below via
// declaration merging + `Object.assign(EngineClient.prototype, …)`.
// The resource modules import only the `EngineClient` TYPE from here,
// so there is no runtime import cycle.

import { EngineError, TransportError } from "@cli-core/errors.ts";
import {
  type DebugCorrelationFields,
  type DebugMode,
  debugLog,
  extractTraceId,
  isDebugVerbose,
  serializeDebugError,
} from "./debug.ts";
import { agentMethods } from "./engine-client/agent.ts";
import { chatMethods } from "./engine-client/chat.ts";
import { connectorsMethods } from "./engine-client/connectors.ts";
import { conversationsMethods } from "./engine-client/conversations.ts";
import { diagnosticsMethods } from "./engine-client/diagnostics.ts";
import { eventsMethods } from "./engine-client/events.ts";
import { executionsMethods } from "./engine-client/executions.ts";
import { filesMethods } from "./engine-client/files.ts";
import {
  buildQuery,
  normalizeHeaders,
  parseResponseBody,
  serializeFormData,
} from "./engine-client/http.ts";
import { identityMethods } from "./engine-client/identity.ts";
import { knowledgeMethods } from "./engine-client/knowledge.ts";
import { oauthMethods } from "./engine-client/oauth.ts";
import { rbacMethods } from "./engine-client/rbac.ts";
import { selfHealingMethods } from "./engine-client/self-healing.ts";
import { settingsMethods } from "./engine-client/settings.ts";
import { skillsMethods } from "./engine-client/skills.ts";
import { statsMethods } from "./engine-client/stats.ts";
import { workflowsMethods } from "./engine-client/workflows.ts";

// ---------- Re-exported resource-module surface ----------
// The wire types (and the few value exports) moved with their method
// groups into `./engine-client/*.ts`; re-exporting them here keeps
// every existing `from "./engine-client.ts"` import site working.
export type { ConnectorPromotionResponse } from "./engine-client/connectors.ts";
export type {
  ConversationContextSnapshot,
  ConversationDetail,
  ConversationRunOutcome,
  ConversationSummary,
  ExtendedTurnUsage,
  RequestCredentialFormEvent,
  ResumeSummary,
} from "./engine-client/conversations.ts";
export { readExtendedTurnUsage } from "./engine-client/conversations.ts";
export type {
  DiagnosticsRuntime,
  EngineErrorEntry,
  SetupValidationIssue,
  SetupValidationResponse,
  SetupValidationSection,
  SetupValidationValue,
  StatusSummary,
} from "./engine-client/diagnostics.ts";
export type {
  ConnectorResolutionSummary,
  ExecutionCost,
  RunExecutionBody,
  RunExecutionResponse,
  RunExecutionStepSummary,
} from "./engine-client/executions.ts";
export type {
  BatchCreateEntry,
  BatchCreateRequest,
  BatchCreateResponse,
  BatchCreateResponseEntry,
  FileLinkWire,
  FileStatsWire,
  FileStatusWire,
  FileWire,
} from "./engine-client/files.ts";
export {
  FILE_LINK_RESOURCE_TYPES,
  type FileLinkResourceType,
  MAX_INLINE_BYTES,
} from "./engine-client/files.ts";
export type {
  IdentityUserWire,
  InviteRedeemedWire,
  UserInviteIssuedWire,
  UserInviteWire,
} from "./engine-client/identity.ts";
export type {
  AttentionItem,
  DigestAttention,
  DigestFailureGroup,
  DigestPatch,
  FailureOrigin,
  OperatorHealthDigest,
  RiskSeverity,
  RiskSignal,
} from "./engine-client/self-healing.ts";
export { attentionOf, resolvedAtOf, scheduledRunsOf } from "./engine-client/self-healing.ts";
export type {
  SettingLeafEntry,
  SettingLeafMeta,
  SettingPutResult,
  SettingSource,
  SettingsListResponse,
} from "./engine-client/settings.ts";
export type {
  StatsAuditResponse,
  StatsDurationAgg,
  StatsExecutionsResponse,
  StatsLatencyAgg,
  StatsLlmResponse,
  StatsQualityResponse,
  StatsQuery,
  StatsTokenAgg,
  StatsUsageResponse,
} from "./engine-client/stats.ts";
export type { ScheduleEntry } from "./engine-client/workflows.ts";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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

export class EngineClient {
  // Internal transport plumbing. Not `private` because the resource
  // method modules under `./engine-client/` execute with
  // `this: EngineClient` and need it — they are the same logical unit
  // as this class, split across files for size. Not part of the
  // supported surface for other callers.
  readonly base: string;
  readonly apiKey: string;
  readonly tenant: string | null;
  readonly fetchImpl: FetchLike;
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

  headers(extra?: Record<string, string>, opts?: { traceId?: string }): Record<string, string> {
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

  newClientTraceId(): string {
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

  /** #304: the elicitation-respond POST body carries the operator's typed
   *  answer — which may be a connector secret entered into a masked form.
   *  The engine already redacts it at rest and on replay; the CLI's verbose
   *  debug.log must not capture the raw POST body regardless of the value's
   *  key name or entropy (the shared `redact()` only catches known key names
   *  / value shapes). Match the endpoint and drop the body wholesale. */
  private isSensitiveRequestBodyPath(path: string): boolean {
    return /\/elicitations\/[^/]+\/respond$/.test(path);
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
              request_body: this.isSensitiveRequestBodyPath(path)
                ? { _redacted: "elicitation_respond_body" }
                : (body ?? null),
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
      throw new TransportError(cause);
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
      throw new EngineError(res.status, parsed);
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
      throw new TransportError(cause);
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
          ? {
              request_headers: normalizeHeaders(init.headers),
              request_body: this.isSensitiveRequestBodyPath(path)
                ? { _redacted: "elicitation_respond_body" }
                : (body ?? null),
            }
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
      throw new TransportError(cause);
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
      throw new EngineError(res.status, parsed);
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

  // -------------------- Multipart helper --------------------
  async requestForm<T = unknown>(
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
      throw new TransportError(cause);
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
      throw new EngineError(res.status, parsed);
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

  debugContext(debugContext?: DebugCorrelationFields): DebugCorrelationFields {
    return { mode: this.debugMode, ...debugContext };
  }
}

/** Strips the explicit `this: EngineClient` parameter each resource
 *  module declares, so the merged interface exposes plain instance
 *  methods. */
type ApiMethods<T> = { [K in keyof T]: OmitThisParameter<T[K]> };

// Declaration merging: the per-resource method groups become part of
// the `EngineClient` instance type…
export interface EngineClient
  extends ApiMethods<typeof agentMethods>,
    ApiMethods<typeof chatMethods>,
    ApiMethods<typeof connectorsMethods>,
    ApiMethods<typeof conversationsMethods>,
    ApiMethods<typeof diagnosticsMethods>,
    ApiMethods<typeof eventsMethods>,
    ApiMethods<typeof executionsMethods>,
    ApiMethods<typeof filesMethods>,
    ApiMethods<typeof identityMethods>,
    ApiMethods<typeof knowledgeMethods>,
    ApiMethods<typeof oauthMethods>,
    ApiMethods<typeof rbacMethods>,
    ApiMethods<typeof selfHealingMethods>,
    ApiMethods<typeof settingsMethods>,
    ApiMethods<typeof skillsMethods>,
    ApiMethods<typeof statsMethods>,
    ApiMethods<typeof workflowsMethods> {}

// …and of the runtime prototype. Method names are globally unique
// across the groups, so assignment order carries no meaning.
Object.assign(
  EngineClient.prototype,
  agentMethods,
  chatMethods,
  connectorsMethods,
  conversationsMethods,
  diagnosticsMethods,
  eventsMethods,
  executionsMethods,
  filesMethods,
  identityMethods,
  knowledgeMethods,
  oauthMethods,
  rbacMethods,
  selfHealingMethods,
  settingsMethods,
  skillsMethods,
  statsMethods,
  workflowsMethods,
);
