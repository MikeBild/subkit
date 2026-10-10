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
import { catalogMethods } from "./engine-client/catalog.ts";
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
import { intakeMethods } from "./engine-client/intake.ts";
import { knowledgeMethods } from "./engine-client/knowledge.ts";
import { oauthMethods } from "./engine-client/oauth.ts";
import { rbacMethods } from "./engine-client/rbac.ts";
import { selfHealingMethods } from "./engine-client/self-healing.ts";
import { settingsMethods } from "./engine-client/settings.ts";
import { skillsMethods } from "./engine-client/skills.ts";
import { statsMethods } from "./engine-client/stats.ts";
import { workflowsMethods } from "./engine-client/workflows.ts";

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
export type { IntakeItem } from "./engine-client/intake.ts";
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
export type {
  EngineRestartAccepted,
  EngineRestartStatus,
  SettingLeafEntry,
  SettingLeafMeta,
  SettingPutResult,
  SettingSource,
  SettingsListResponse,
} from "./engine-client/settings.ts";
export type {
  OperatingFigures,
  StatsAuditResponse,
  StatsDurationAgg,
  StatsExecutionsResponse,
  StatsLatencyAgg,
  StatsLlmCost,
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
  user_agent?: string | undefined;
  debug_mode?: DebugMode | undefined;
}

export class EngineClient {
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
    const rand =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().replace(/-/g, "")
        : Math.random().toString(36).slice(2).padEnd(16, "0");
    return `cli-${rand.slice(0, 16)}`;
  }

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

  async requestForm<T = unknown>(
    method: string,
    path: string,
    form: FormData,
    debugContext?: DebugCorrelationFields,
  ): Promise<T> {
    const qs = "";
    const url = `${this.base}${path}${qs}`;
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

type ApiMethods<T> = { [K in keyof T]: OmitThisParameter<T[K]> };

export interface EngineClient
  extends ApiMethods<typeof agentMethods>,
    ApiMethods<typeof catalogMethods>,
    ApiMethods<typeof chatMethods>,
    ApiMethods<typeof connectorsMethods>,
    ApiMethods<typeof conversationsMethods>,
    ApiMethods<typeof diagnosticsMethods>,
    ApiMethods<typeof eventsMethods>,
    ApiMethods<typeof executionsMethods>,
    ApiMethods<typeof filesMethods>,
    ApiMethods<typeof identityMethods>,
    ApiMethods<typeof intakeMethods>,
    ApiMethods<typeof knowledgeMethods>,
    ApiMethods<typeof oauthMethods>,
    ApiMethods<typeof rbacMethods>,
    ApiMethods<typeof selfHealingMethods>,
    ApiMethods<typeof settingsMethods>,
    ApiMethods<typeof skillsMethods>,
    ApiMethods<typeof statsMethods>,
    ApiMethods<typeof workflowsMethods> {}

Object.assign(
  EngineClient.prototype,
  agentMethods,
  catalogMethods,
  chatMethods,
  connectorsMethods,
  conversationsMethods,
  diagnosticsMethods,
  eventsMethods,
  executionsMethods,
  filesMethods,
  identityMethods,
  intakeMethods,
  knowledgeMethods,
  oauthMethods,
  rbacMethods,
  selfHealingMethods,
  settingsMethods,
  skillsMethods,
  statsMethods,
  workflowsMethods,
);
