// Thin typed client over the subkit engine's REST API, scoped to the
// surfaces the `sk` end-user CLI needs. Hand-written rather than
// `hono/client` so the compiled binary stays tight — pulling the
// engine's `AppType` through Hono drags the entire server module
// graph in. Deliberately separate from apps/cli/src/engine-client.ts
// because the two CLIs wrap different engine surfaces.

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
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    const msg =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message: unknown }).message)
        : typeof body === "string"
          ? body
          : `HTTP ${status}`;
    super(msg);
    this.name = "SkEngineError";
    this.status = status;
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
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (cause) {
      throw new SkTransportError(cause);
    }
    const text = await res.text();
    if (!res.ok) {
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep as string */
      }
      throw new SkEngineError(res.status, parsed);
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
  decideApproval(
    conversationId: string,
    approvalId: string,
    decision: "approved" | "rejected",
    reason?: string,
  ): Promise<ConversationRunOutcome> {
    const path =
      decision === "approved"
        ? `/v1/conversations/${conversationId}/approvals/${approvalId}/approve`
        : `/v1/conversations/${conversationId}/approvals/${approvalId}/reject`;
    const body = decision === "rejected" && reason ? { reason } : undefined;
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
