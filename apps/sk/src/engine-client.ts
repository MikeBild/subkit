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
  getConversationContextSnapshot(id: string): Promise<ConversationContextSnapshot> {
    return this.request("GET", `/v1/conversations/${id}/context-snapshot`);
  }
  streamConversation(id: string): Promise<Response> {
    return this.stream(`/v1/conversations/${id}/stream`);
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

  getDiagnosticsLlm(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/diagnostics/llm");
  }

  // -------------------- Multipart helper --------------------
  private async requestForm<T = unknown>(method: string, path: string, form: FormData): Promise<T> {
    const qs = "";
    const url = `${this.base}${path}${qs}`;
    // Omit content-type so the browser/bun sets it with boundary automatically.
    const h: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.userAgent,
    };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    if (this.tenant) h["x-subkit-tenant"] = this.tenant;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers: h, body: form });
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
  patchWorkflow(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/workflows/${encodeURIComponent(id)}`, body);
  }
  deleteWorkflow(id: string): Promise<void> {
    return this.request("DELETE", `/v1/workflows/${encodeURIComponent(id)}`);
  }
  runWorkflow(id: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/workflows/${encodeURIComponent(id)}/run`, body);
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
  deleteConnectorTemplate(id: string): Promise<void> {
    return this.request("DELETE", `/v1/connector-templates/${encodeURIComponent(id)}`);
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

  // -------------------- Tunnels --------------------
  listTunnels(): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/tunnels");
  }
  getTunnel(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/tunnels/${encodeURIComponent(id)}`);
  }
  createTunnel(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/tunnels", body);
  }
  deleteTunnel(id: string): Promise<void> {
    return this.request("DELETE", `/v1/tunnels/${encodeURIComponent(id)}`);
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
    if (Object.keys(metadata).length > 0) form.append("metadata", JSON.stringify(metadata));
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
  draft_summary: {
    readiness: string;
    next_action: string | null;
    missing_fields: string[];
    progress_label: string | null;
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
