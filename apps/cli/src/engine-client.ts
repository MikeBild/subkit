// Typed wrapper over the subkit engine's REST API.
//
// For P15 we hand-write this instead of importing `hono/client` because
// the CLI is compiled as a standalone binary and pulling the engine's
// `AppType` through the Hono type hierarchy drags the entire server
// module graph into the CLI build. This wrapper ships the exact fetch
// calls the CLI needs, keeping the compile small and the surface area
// reviewable.

import { EngineError, type EngineErrorBody, TransportError } from "./utils/errors.ts";

/** Minimal fetch shape — we don't rely on preconnect etc. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  engine_url: string;
  api_key: string;
  tenant?: string | null | undefined;
  fetchImpl?: FetchLike | undefined;
}

/**
 * The HTTP methods + paths are declared at each call site. We keep the
 * returned types minimal — `unknown` at the edges, narrowed by commands
 * that actually consume a specific field.
 */
export class EngineClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly tenant: string | null;
  private readonly fetchImpl: FetchLike;

  constructor(opts: ClientOptions) {
    this.base = opts.engine_url.replace(/\/+$/, "");
    this.apiKey = opts.api_key;
    this.tenant = opts.tenant ?? null;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
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
    const init: RequestInit = {
      method,
      headers: this.headers(),
    };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (cause) {
      throw new TransportError(cause);
    }
    const text = await res.text();
    if (!res.ok) {
      let parsed: EngineErrorBody | string = text;
      try {
        parsed = JSON.parse(text) as EngineErrorBody;
      } catch {
        /* keep as string */
      }
      throw new EngineError(res.status, parsed);
    }
    if (!text || res.status === 204) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /** GET helper for SSE — returns the raw Response so callers can stream. */
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
      throw new TransportError(cause);
    }
  }

  // --------------------------- Health ---------------------------
  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/v1/health");
  }

  // --------------------------- Workflows ---------------------------
  listWorkflows(query: WorkflowListQuery = {}): Promise<{ items: WorkflowSummary[] }> {
    return this.request(
      "GET",
      "/v1/workflows",
      undefined,
      query as Record<string, string | number | boolean | undefined>,
    );
  }
  getWorkflow(id: string): Promise<WorkflowSummary> {
    return this.request("GET", `/v1/workflows/${id}`);
  }
  runWorkflow(id: string, body: { input?: unknown; request_source?: string }, sync = true) {
    return this.request<{ id: string; status: string; output?: unknown; error?: unknown }>(
      "POST",
      `/v1/workflows/${id}/run`,
      body,
      { sync: sync ? 1 : 0 },
    );
  }
  deleteWorkflow(id: string): Promise<void> {
    return this.request<void>("DELETE", `/v1/workflows/${id}`);
  }
  workflowHistory(id: string): Promise<{ items: WorkflowVersionSummary[] }> {
    return this.request("GET", `/v1/workflows/${id}/history`);
  }
  restoreWorkflow(id: string, version: number): Promise<WorkflowSummary> {
    return this.request("POST", `/v1/workflows/${id}/restore/${version}`);
  }
  createWorkflow(body: Record<string, unknown>): Promise<WorkflowSummary> {
    return this.request("POST", "/v1/workflows", body);
  }

  // --------------------------- Connectors ---------------------------
  listConnectors(
    query: { environment?: "dev" | "prod" } = {},
  ): Promise<{ items: ConnectorSummary[] }> {
    return this.request("GET", "/v1/connectors", undefined, query);
  }
  getConnector(id: string): Promise<ConnectorSummary> {
    return this.request("GET", `/v1/connectors/${id}`);
  }
  createConnector(body: Record<string, unknown>): Promise<ConnectorSummary> {
    return this.request("POST", "/v1/connectors", body);
  }
  testConnector(id: string): Promise<{ ok: boolean; latency_ms: number; detail?: string }> {
    return this.request("POST", `/v1/connectors/${id}/test`);
  }
  ingestConnectorDocs(id: string, body: { source_type: string; url?: string; content?: string }) {
    return this.request("POST", `/v1/connectors/${id}/docs/ingest`, body);
  }
  searchConnectorDocs(id: string, q: string, limit?: number) {
    return this.request("GET", `/v1/connectors/${id}/docs/search`, undefined, {
      q,
      limit,
    });
  }

  // --------------------------- Credentials ---------------------------
  createCredential(connectorId: string, body: Record<string, unknown>): Promise<{ id: string }> {
    return this.request("POST", `/v1/connectors/${connectorId}/credentials`, body);
  }

  // --------------------------- Skills ---------------------------
  listSkills(query: Record<string, string | undefined> = {}): Promise<{ items: SkillSummary[] }> {
    return this.request("GET", "/v1/skills", undefined, query);
  }
  getSkill(id: string): Promise<SkillSummary> {
    return this.request("GET", `/v1/skills/${id}`);
  }
  createSkill(body: Record<string, unknown>): Promise<SkillSummary> {
    return this.request("POST", "/v1/skills", body);
  }
  patchSkill(id: string, body: Record<string, unknown>): Promise<SkillSummary> {
    return this.request("PATCH", `/v1/skills/${id}`, body);
  }
  activateSkill(id: string): Promise<SkillSummary> {
    return this.request("POST", `/v1/skills/${id}/activate`);
  }
  archiveSkill(id: string): Promise<SkillSummary> {
    return this.request("POST", `/v1/skills/${id}/archive`);
  }

  // --------------------------- Executions ---------------------------
  listExecutions(query: Record<string, string | number | undefined> = {}) {
    return this.request<{ items: ExecutionSummary[] }>("GET", "/v1/executions", undefined, query);
  }
  getExecution(id: string): Promise<ExecutionSummary> {
    return this.request("GET", `/v1/executions/${id}`);
  }
  executionSteps(id: string): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", `/v1/executions/${id}/steps`);
  }
  cancelExecution(id: string): Promise<void> {
    return this.request<void>("POST", `/v1/executions/${id}/cancel`);
  }

  // --------------------------- Hooks inbound ---------------------------
  listHooksInbound(): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/webhooks/inbound");
  }
  createHookInbound(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/webhooks/inbound", body);
  }

  // --------------------------- Subscriptions ---------------------------
  listSubscriptions(): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/subscriptions");
  }
  createSubscription(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/subscriptions", body);
  }
  replaySubscriptionDelivery(id: string, deliveryId: string) {
    return this.request("POST", `/v1/subscriptions/${id}/deliveries/${deliveryId}/replay`);
  }

  // --------------------------- Events ---------------------------
  listEvents(query: Record<string, string | number | undefined> = {}) {
    return this.request<{ items: Record<string, unknown>[] }>(
      "GET",
      "/v1/events",
      undefined,
      query,
    );
  }

  // --------------------------- Tunnels ---------------------------
  listTunnels(): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/tunnels");
  }
  createTunnel(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/tunnels", body);
  }

  // --------------------------- Identity: api keys ---------------------------
  listApiKeys(): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/identity/api-keys");
  }
  issueApiKey(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/identity/api-keys", body);
  }
  rotateApiKey(id: string, body: Record<string, unknown> = {}) {
    return this.request<Record<string, unknown>>(
      "POST",
      `/v1/identity/api-keys/${id}/rotate`,
      body,
    );
  }
  revokeApiKey(id: string): Promise<void> {
    return this.request<void>("DELETE", `/v1/identity/api-keys/${id}`);
  }

  // --------------------------- Identity: portal tokens ---------------------------
  listPortalTokens(): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/identity/portal-tokens");
  }
  issuePortalToken(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/identity/portal-tokens", body);
  }
  revokePortalToken(id: string): Promise<void> {
    return this.request<void>("DELETE", `/v1/identity/portal-tokens/${id}`);
  }

  // --------------------------- Conversations ---------------------------
  createConversation(body: {
    initial_message?: string;
    connector_id?: string;
    workflow_id?: string;
  }): Promise<ConversationRunOutcome> {
    return this.request<ConversationRunOutcome>("POST", "/v1/conversations", body);
  }
  getConversation(id: string): Promise<ConversationDetail> {
    return this.request<ConversationDetail>("GET", `/v1/conversations/${id}`);
  }
  appendConversationMessage(id: string, message: string): Promise<ConversationRunOutcome> {
    return this.request<ConversationRunOutcome>("POST", `/v1/conversations/${id}/messages`, {
      message,
    });
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
    return this.request<ConversationRunOutcome>("POST", path, body);
  }
  cancelConversation(id: string): Promise<unknown> {
    return this.request("POST", `/v1/conversations/${id}/cancel`);
  }
  /** Open the SSE stream for a conversation; caller drives `readSse`. */
  streamConversation(id: string): Promise<Response> {
    return this.stream(`/v1/conversations/${id}/stream`);
  }

  // --------------------------- AI Extract ---------------------------
  extract(body: { sample: string; hint?: string }) {
    return this.request<{
      schema: unknown;
      data: unknown;
      tokens: Record<string, number>;
      model_used: string;
      fell_back: boolean;
    }>("POST", "/v1/ai/extract", body);
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

export interface HealthResponse {
  status: string;
  version: string;
  db_connected: boolean;
  uptime_seconds: number;
}

export interface WorkflowSummary {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  lifecycle: string;
  current_version_id: string | null;
  current_version: number | null;
  created_at: string;
  updated_at: string;
  steps: unknown[];
}

export interface WorkflowListQuery {
  limit?: number;
  offset?: number;
  status?: "draft" | "active" | "archived";
  name_contains?: string;
}

export interface WorkflowVersionSummary {
  id: string;
  workflow_id: string;
  version: number;
  note: string | null;
  created_at: string;
  dag: unknown;
}

export interface ConnectorSummary {
  id: string;
  slug: string;
  display_name: string;
  driver: string;
  environment: string;
  auth_type: string;
  base_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  scope: string;
  lifecycle: string;
}

export interface ConversationSummary {
  id: string;
  tenant_id: string;
  target_workflow_id: string | null;
  target_connector_id: string | null;
  status: string;
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

export interface ExecutionSummary {
  id: string;
  workflow_id: string;
  status: string;
  request_source: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}
