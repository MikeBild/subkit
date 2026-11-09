import type { components } from "@cli-core/engine-api/openapi";
import { cockpitApiHref } from "@/app/installation-context";
import { apiCall } from "./call";
import { tenantContextHeaders } from "./tenant-context";
import { ApiError, apiRequest, csrfHeaders, failure } from "./transport";

export {
  ApiError,
  apiRequest,
  apiText,
  apiUpload,
  BOOTSTRAP_TIMEOUT_MS,
  bootstrap,
  bootstrapLimits,
  noticeSessionExpiry,
  onSessionExpired,
  type RequestLimits,
  retryQuery,
} from "./transport";

export type Bootstrap = components["schemas"]["CockpitBootstrapResponse"];
export type Conversation = components["schemas"]["Conversation"];
export type ConversationDetail = components["schemas"]["ConversationDetail"];
export type ConversationList = components["schemas"]["ConversationListResponse"];
type ConversationRun = components["schemas"]["ConversationRunOutcome"];
export type UiMessage = components["schemas"]["UIMessage"];
export type ConversationReference = components["schemas"]["ConversationReference"];

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

export interface ConversationsAboutTarget {
  workflow_id?: string;
  connector_id?: string;
  skill_id?: string;
  knowledge_source_id?: string;
}

export function conversationsAboutQuery(
  target: ConversationsAboutTarget,
  limit = 8,
): URLSearchParams {
  const params = new URLSearchParams({
    owner_kind: "user",
    limit: String(limit),
    sort: "updated_at",
    order: "desc",
  });
  if (target.workflow_id) params.set("target_workflow_id", target.workflow_id);
  if (target.connector_id) params.set("target_connector_id", target.connector_id);
  if (target.skill_id) params.set("referenced_skill_id", target.skill_id);
  if (target.knowledge_source_id) {
    params.set("referenced_knowledge_source_id", target.knowledge_source_id);
  }
  return params;
}

export function listConversationsAbout(
  target: ConversationsAboutTarget,
  limit = 8,
): Promise<ConversationList> {
  return apiRequest(`/v1/conversations?${conversationsAboutQuery(target, limit)}`);
}

export function setConversationHidden(id: string, hidden: boolean): Promise<Conversation> {
  return apiCall("post", hidden ? "/v1/conversations/{id}/hide" : "/v1/conversations/{id}/unhide", {
    path: { id },
  });
}

export function deleteConversation(id: string): Promise<{ id: string; deleted: true }> {
  return apiCall("delete", "/v1/conversations/{id}", { path: { id } });
}

export function getConversation(id: string): Promise<ConversationDetail> {
  return apiRequest(`/v1/conversations/${encodeURIComponent(id)}`);
}

type ConversationStreamEvent = { type: string; [key: string]: unknown };

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
  for (const [key, value] of Object.entries(csrfHeaders())) headers.set(key, value);
  for (const [key, value] of Object.entries(tenantContextHeaders())) headers.set(key, value);
  const response = await fetch(cockpitApiHref(path), {
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
  const pathId = path.match(/^\/v1\/conversations\/([^/]+)/)?.[1];
  let expectedId = pathId ? decodeURIComponent(pathId) : null;
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
      const recordId = (parsed.conversation as { id?: unknown } | undefined)?.id;
      const eventId =
        typeof parsed.conversation_id === "string"
          ? parsed.conversation_id
          : typeof recordId === "string"
            ? recordId
            : null;
      if (eventId && expectedId && eventId !== expectedId) {
        await reader.cancel();
        throw new ApiError(
          409,
          {
            code: "conversation_stream_mismatch",
            message:
              "The response does not belong to this conversation. Reload the conversation before continuing.",
          },
          response.headers.get("x-trace-id"),
        );
      }
      if (eventName === "conversation_started" && eventId) expectedId = eventId;
      if (eventName === "outcome") {
        outcome = { ...parsed, events: [] } as unknown as ConversationRun;
      } else if (eventName === "error")
        throw new ApiError(
          parsed.code === "conversation_turn_in_progress" ? 409 : 500,
          parsed,
          response.headers.get("x-trace-id"),
        );
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

type SendConversationTurnInput = {
  message: string;
  references?: readonly ConversationReference[];
} & (
  | {
      conversationId: string;
      target?: never;
      pendingElicitation?: { id: string; tool_name: string } | null;
    }
  | {
      conversationId?: null;
      target?: ConversationTarget;
      permissionMode?: "auto" | "ask" | "plan";
      intake_item_ids?: readonly string[];
    }
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
      ...("intake_item_ids" in input && input.intake_item_ids?.length
        ? { intake_item_ids: input.intake_item_ids }
        : {}),
      ...withReferences(input.references),
    },
    onEvent,
  );
}

export function renameConversation(id: string, title: string): Promise<Conversation> {
  return apiCall("patch", "/v1/conversations/{id}", { path: { id }, body: { title } });
}

export function cancelConversation(id: string): Promise<unknown> {
  return apiCall("post", "/v1/conversations/{id}/cancel", { path: { id } });
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

function respondToChatText(
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
  return apiCall("post", "/v1/conversations/{id}/tool-calls/{tool_call_id}/respond", {
    path: { id: conversationId, tool_call_id: toolCallId },
    body: { output: { approved } },
  });
}

export async function logout(): Promise<{ endSessionUrl: string | null }> {
  const result = await apiCall("post", "/v1/identity/logout", {});
  const url = result?.end_session_url;
  return { endSessionUrl: typeof url === "string" && /^https:\/\//.test(url) ? url : null };
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
