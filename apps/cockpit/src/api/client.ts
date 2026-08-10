import type { components } from "./schema";

export type Bootstrap = components["schemas"]["CockpitBootstrapResponse"];
export type Conversation = components["schemas"]["Conversation"];
export type ConversationDetail = components["schemas"]["ConversationDetail"];
export type ConversationList = components["schemas"]["ConversationListResponse"];
export type ConversationRun = components["schemas"]["ConversationRunOutcome"];
export type UiMessage = components["schemas"]["UIMessage"];

let csrfToken: string | null = null;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly traceId: string | null;

  constructor(status: number, body: unknown, traceId: string | null) {
    const record = isRecord(body) ? body : {};
    super(typeof record.message === "string" ? record.message : `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = typeof record.code === "string" ? record.code : null;
    this.traceId = traceId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("x-subkit-client", "cockpit");
  if (init.body && !(init.body instanceof FormData))
    headers.set("content-type", "application/json");
  const method = (init.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) {
    headers.set("x-subkit-csrf", csrfToken);
  }
  const response = await fetch(path, { ...init, credentials: "same-origin", headers });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body, response.headers.get("x-trace-id"));
  return body as T;
}

export async function bootstrap(): Promise<Bootstrap> {
  const result = await apiRequest<Bootstrap>("/v1/cockpit/bootstrap");
  csrfToken = result.csrf_token;
  return result;
}

export function listConversations(): Promise<ConversationList> {
  return apiRequest("/v1/conversations?owner=me&limit=100");
}

export function getConversation(id: string): Promise<ConversationDetail> {
  return apiRequest(`/v1/conversations/${encodeURIComponent(id)}`);
}

export function createConversation(initialMessage: string): Promise<ConversationRun> {
  return apiRequest("/v1/conversations", {
    method: "POST",
    body: JSON.stringify({ initial_message: initialMessage, permission_mode: "ask" }),
  });
}

export function appendConversationMessage(id: string, message: string): Promise<ConversationRun> {
  return apiRequest(`/v1/conversations/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export function cancelConversation(id: string): Promise<unknown> {
  return apiRequest(`/v1/conversations/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function respondToToolCall(
  conversationId: string,
  toolCallId: string,
  approved: boolean,
): Promise<ConversationRun> {
  return apiRequest(
    `/v1/conversations/${encodeURIComponent(conversationId)}/tool-calls/${encodeURIComponent(toolCallId)}/respond`,
    {
      method: "POST",
      body: JSON.stringify({ output: { approved } }),
    },
  );
}

export function logout(): Promise<void> {
  return apiRequest("/v1/identity/logout", { method: "POST" });
}
