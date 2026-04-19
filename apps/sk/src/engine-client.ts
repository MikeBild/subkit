// Thin typed client over the subkit engine's REST API, scoped to the
// surfaces the `sk` end-user CLI needs. Hand-written rather than
// `hono/client` so the compiled binary stays tight — pulling the
// engine's `AppType` through Hono drags the entire server module
// graph in. Deliberately separate from apps/cli/src/engine-client.ts
// because the two CLIs wrap different engine surfaces.

import { debugLog, isDebugMode } from "./debug.ts";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  engine_url: string;
  api_key: string;
  tenant?: string | null | undefined;
  fetchImpl?: FetchLike | undefined;
  /** User-Agent header value. sk-cli sets its own to tag audit rows. */
  user_agent?: string | undefined;
}

export class SkEngineError extends Error {
  readonly status: number;
  readonly code: string;
  readonly trace_id: string | null;
  readonly details: unknown;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    const parsed =
      typeof body === "object" && body !== null
        ? (body as { code?: unknown; message?: unknown; trace_id?: unknown; details?: unknown })
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

  constructor(opts: ClientOptions) {
    this.base = opts.engine_url.replace(/\/+$/, "");
    this.apiKey = opts.api_key;
    this.tenant = opts.tenant ?? null;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.userAgent = opts.user_agent ?? "sk-cli/0.0.1";
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": this.userAgent,
      ...extra,
    };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    if (this.tenant) h["x-subkit-tenant"] = this.tenant;
    return h;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const qs = buildQuery(query);
    const url = `${this.base}${path}${qs}`;
    const init: RequestInit = { method, headers: this.headers() };
    if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
    const startedAt = Date.now();
    const debugActive = isDebugMode();
    if (debugActive) {
      debugLog("http.request", {
        method,
        url,
        tenant: this.tenant,
        body_bytes: typeof init.body === "string" ? init.body.length : 0,
      });
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (cause) {
      const duration_ms = Date.now() - startedAt;
      if (debugActive) {
        debugLog("http.transport_error", {
          method,
          url,
          duration_ms,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
      throw new SkTransportError(cause);
    }
    const text = await res.text();
    const duration_ms = Date.now() - startedAt;
    if (!res.ok) {
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep as string */
      }
      if (debugActive) {
        debugLog("http.response", {
          method,
          url,
          status: res.status,
          duration_ms,
          // Cap the body excerpt so a large 500 page does not blow the
          // log file; the full text already lives in the engine logs.
          body: typeof parsed === "string" ? parsed.slice(0, 2000) : parsed,
          trace_id: res.headers.get("x-trace-id") ?? res.headers.get("x-request-id") ?? null,
        });
      }
      throw new SkEngineError(res.status, parsed);
    }
    if (debugActive) {
      debugLog("http.response", {
        method,
        url,
        status: res.status,
        duration_ms,
        body_bytes: text.length,
      });
    }
    if (!text || res.status === 204) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  async stream(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<Response> {
    const qs = buildQuery(query);
    const url = `${this.base}${path}${qs}`;
    try {
      return await this.fetchImpl(url, {
        method: "GET",
        headers: this.headers({ accept: "text/event-stream" }),
      });
    } catch (cause) {
      throw new SkTransportError(cause);
    }
  }

  // --------------------------- Health + Health-like ---------------------------
  health(): Promise<{ status: string; db_connected: boolean }> {
    return this.request("GET", "/v1/health");
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

  // --------------------------- Conversations ---------------------------
  listConversations(
    query: { status?: string; owner?: "me"; limit?: number; offset?: number } = {},
  ): Promise<{ items: ConversationSummary[] }> {
    return this.request("GET", "/v1/conversations", undefined, query);
  }
  createConversation(body: {
    initial_message?: string;
    connector_id?: string;
    workflow_id?: string;
    memory?: string;
    model?: string;
    title?: string;
  }): Promise<ConversationRunOutcome> {
    return this.request("POST", "/v1/conversations", body);
  }
  getConversation(id: string): Promise<ConversationDetail> {
    return this.request("GET", `/v1/conversations/${id}`);
  }
  appendConversationMessage(
    id: string,
    body: { message: string; memory?: string },
  ): Promise<ConversationRunOutcome> {
    return this.request("POST", `/v1/conversations/${id}/messages`, body);
  }
  patchConversation(
    id: string,
    body: { model?: string | null; title?: string | null },
  ): Promise<ConversationSummary> {
    return this.request("PATCH", `/v1/conversations/${id}`, body);
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
  respondElicitation(
    conversationId: string,
    elicitationId: string,
    output: unknown,
    reason?: string,
  ): Promise<ConversationRunOutcome> {
    const path = `/v1/conversations/${conversationId}/elicitations/${elicitationId}/respond`;
    const body: Record<string, unknown> = { output };
    if (reason) body.reason = reason;
    return this.request("POST", path, body);
  }
  cancelConversation(id: string): Promise<unknown> {
    return this.request("POST", `/v1/conversations/${id}/cancel`);
  }
  streamConversation(id: string): Promise<Response> {
    return this.stream(`/v1/conversations/${id}/stream`);
  }

  // --------------------------- Skills ---------------------------
  listSkills(): Promise<{ items: Array<{ id: string; title: string; scope: string }> }> {
    return this.request("GET", "/v1/skills");
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
  approvals: unknown[];
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
