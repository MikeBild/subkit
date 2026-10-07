import type { components } from "./schema";

export type Bootstrap = components["schemas"]["CockpitBootstrapResponse"];
export type Conversation = components["schemas"]["Conversation"];
export type ConversationDetail = components["schemas"]["ConversationDetail"];
export type ConversationList = components["schemas"]["ConversationListResponse"];
export type ConversationRun = components["schemas"]["ConversationRunOutcome"];
export type UiMessage = components["schemas"]["UIMessage"];
export type ConversationReference = components["schemas"]["ConversationReference"];

let csrfToken: string | null = null;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly traceId: string | null;
  readonly details: Record<string, unknown> | null;

  constructor(status: number, body: unknown, traceId: string | null) {
    const record = isRecord(body) ? body : {};
    super(typeof record.message === "string" ? record.message : `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = typeof record.code === "string" ? record.code : null;
    this.traceId = traceId;
    this.details = isRecord(record.details) ? record.details : null;
  }
}

const sessionExpiryListeners = new Set<() => void>();

export function isSessionExpiry(status: number, code: string | null): boolean {
  return status === 401 && code === "unauthorized";
}

export function onSessionExpired(listener: () => void): () => void {
  sessionExpiryListeners.add(listener);
  return () => {
    sessionExpiryListeners.delete(listener);
  };
}

export function noticeSessionExpiry(status: number, code: string | null): void {
  if (!isSessionExpiry(status, code)) return;
  for (const listener of sessionExpiryListeners) listener();
}

export function retryQuery(failures: number, error: unknown): boolean {
  if (error instanceof ApiError && isSessionExpiry(error.status, error.code)) return false;
  return failures < 3;
}

function failure(status: number, body: unknown, traceId: string | null): ApiError {
  const error = new ApiError(status, body, traceId);
  noticeSessionExpiry(error.status, error.code);
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const BOOTSTRAP_TIMEOUT_MS = 5000;

export interface RequestLimits {
  timeoutMs?: number;
}

function limitedSignal(
  signal: AbortSignal | null | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal ?? undefined;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  limits: RequestLimits = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("x-subkit-client", "cockpit");
  if (init.body && !(init.body instanceof FormData))
    headers.set("content-type", "application/json");
  const method = (init.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) {
    headers.set("x-subkit-csrf", csrfToken);
  }
  const signal = limitedSignal(init.signal, limits.timeoutMs);
  const response = await fetch(path, {
    ...init,
    ...(signal ? { signal } : {}),
    credentials: "same-origin",
    headers,
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  signal?.throwIfAborted();
  if (!response.ok) throw failure(response.status, body, response.headers.get("x-trace-id"));
  return body as T;
}

export function apiUpload<T>(
  path: string,
  body: unknown,
  onProgress: (fraction: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", path);
    request.withCredentials = true;
    request.setRequestHeader("accept", "application/json");
    request.setRequestHeader("content-type", "application/json");
    request.setRequestHeader("x-subkit-client", "cockpit");
    if (csrfToken) request.setRequestHeader("x-subkit-csrf", csrfToken);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      let parsed: unknown = null;
      try {
        parsed = request.responseText ? JSON.parse(request.responseText) : null;
      } catch {
        parsed = null;
      }
      if (request.status >= 200 && request.status < 300) {
        onProgress(1);
        resolve(parsed as T);
      } else reject(failure(request.status, parsed, request.getResponseHeader("x-trace-id")));
    };
    request.onerror = () => reject(new ApiError(0, null, null));
    request.send(JSON.stringify(body));
  });
}

export async function apiText(path: string): Promise<string> {
  const headers = new Headers({ accept: "text/plain", "x-subkit-client": "cockpit" });
  const response = await fetch(path, { credentials: "same-origin", headers });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw failure(response.status, body, response.headers.get("x-trace-id"));
  }
  return response.text();
}

export async function bootstrap(): Promise<Bootstrap> {
  const result = await apiRequest<Bootstrap>(
    "/v1/cockpit/bootstrap",
    {},
    { timeoutMs: BOOTSTRAP_TIMEOUT_MS },
  );
  csrfToken = result.csrf_token;
  return result;
}

export const OWN_CONVERSATIONS = {
  owner: "me",
  owner_kind: "user",
  sort: "updated_at",
  order: "desc",
} as const;

export function listConversations(): Promise<ConversationList> {
  const params = new URLSearchParams({ ...OWN_CONVERSATIONS, limit: "100" });
  return apiRequest(`/v1/conversations?${params}`);
}

export function listConversationsAbout(
  target: { workflow_id?: string; connector_id?: string },
  limit = 8,
): Promise<ConversationList> {
  const params = new URLSearchParams({
    owner_kind: "user",
    limit: String(limit),
    sort: "updated_at",
    order: "desc",
  });
  if (target.workflow_id) params.set("target_workflow_id", target.workflow_id);
  if (target.connector_id) params.set("target_connector_id", target.connector_id);
  return apiRequest(`/v1/conversations?${params}`);
}

export function setConversationHidden(id: string, hidden: boolean): Promise<Conversation> {
  return apiRequest(`/v1/conversations/${encodeURIComponent(id)}/${hidden ? "hide" : "unhide"}`, {
    method: "POST",
  });
}

export function deleteConversation(id: string): Promise<{ id: string; deleted: true }> {
  return apiRequest(`/v1/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getConversation(id: string): Promise<ConversationDetail> {
  return apiRequest(`/v1/conversations/${encodeURIComponent(id)}`);
}

export type ConversationStreamEvent = { type: string; [key: string]: unknown };

async function streamConversation(
  path: string,
  body: Record<string, unknown>,
  onEvent?: (event: ConversationStreamEvent) => void,
): Promise<ConversationRun> {
  const headers = new Headers({
    accept: "text/event-stream",
    "content-type": "application/json",
    "x-subkit-client": "cockpit",
  });
  if (csrfToken) headers.set("x-subkit-csrf", csrfToken);
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    const errorBody = await response.json().catch(() => null);
    throw failure(response.status, errorBody, response.headers.get("x-trace-id"));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outcome: ConversationRun | null = null;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const eventName = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim() ?? "message";
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const parsed = JSON.parse(data) as ConversationStreamEvent;
      if (eventName === "outcome") {
        outcome = { ...parsed, events: [] } as unknown as ConversationRun;
      } else if (eventName === "error")
        throw new ApiError(500, parsed, response.headers.get("x-trace-id"));
      else if (eventName === "conversation_started")
        onEvent?.({ ...parsed, type: "conversation_started" });
      else onEvent?.(parsed);
    }
    if (done) break;
  }
  if (!outcome)
    throw new ApiError(500, { message: "Conversation stream ended without an outcome" }, null);
  return outcome;
}

function withReferences(references?: readonly ConversationReference[]) {
  return references && references.length > 0 ? { references } : {};
}

export type ConversationTarget = {
  workflow_id?: string;
  connector_id?: string;
  execution_id?: string;
};

export type SendConversationTurnInput = {
  message: string;
  references?: readonly ConversationReference[];
} & (
  | {
      conversationId: string;
      target?: never;
      pendingElicitation?: { id: string; tool_name: string } | null;
    }
  | { conversationId?: null; target?: ConversationTarget; permissionMode?: "auto" | "ask" | "plan" }
);

export async function sendConversationTurn(
  input: SendConversationTurnInput,
  onEvent?: (event: ConversationStreamEvent) => void,
): Promise<ConversationRun> {
  if (input.conversationId) {
    const path = `/v1/conversations/${encodeURIComponent(input.conversationId)}`;
    if (input.pendingElicitation?.tool_name === "ask_user_text") {
      return respondToChatText(
        input.conversationId,
        input.pendingElicitation.id,
        input.message,
        onEvent,
      );
    }
    return streamConversation(
      `${path}/messages`,
      { message: input.message, ...withReferences(input.references) },
      onEvent,
    );
  }
  return streamConversation(
    "/v1/conversations",
    {
      initial_message: input.message,
      ...("permissionMode" in input && input.permissionMode
        ? { permission_mode: input.permissionMode }
        : {}),
      ...input.target,
      ...withReferences(input.references),
    },
    onEvent,
  );
}

export function renameConversation(id: string, title: string): Promise<Conversation> {
  return apiRequest(`/v1/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

export function cancelConversation(id: string): Promise<unknown> {
  return apiRequest(`/v1/conversations/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function respondToChatChoice(
  conversationId: string,
  elicitationId: string,
  value: string,
  onEvent?: (event: ConversationStreamEvent) => void,
): Promise<ConversationRun> {
  return streamConversation(
    `/v1/conversations/${encodeURIComponent(conversationId)}/elicitations/${encodeURIComponent(elicitationId)}/respond`,
    { output: { value } },
    onEvent,
  );
}

export function respondToChatText(
  conversationId: string,
  elicitationId: string,
  value: string,
  onEvent?: (event: ConversationStreamEvent) => void,
): Promise<ConversationRun> {
  return streamConversation(
    `/v1/conversations/${encodeURIComponent(conversationId)}/elicitations/${encodeURIComponent(elicitationId)}/respond`,
    { output: { value } },
    onEvent,
  );
}

export function respondToChatApproval(
  conversationId: string,
  elicitationId: string,
  confirmed: boolean,
  onEvent?: (event: ConversationStreamEvent) => void,
): Promise<ConversationRun> {
  return streamConversation(
    `/v1/conversations/${encodeURIComponent(conversationId)}/elicitations/${encodeURIComponent(elicitationId)}/respond`,
    { output: { confirmed } },
    onEvent,
  );
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

export function respondToChatForm(
  conversationId: string,
  elicitationId: string,
  output: Record<string, unknown>,
  onEvent?: (event: ConversationStreamEvent) => void,
): Promise<ConversationRun> {
  return streamConversation(
    `/v1/conversations/${encodeURIComponent(conversationId)}/elicitations/${encodeURIComponent(elicitationId)}/respond`,
    { output },
    onEvent,
  );
}
