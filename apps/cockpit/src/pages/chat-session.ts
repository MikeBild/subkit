import type { ConversationReference, UiMessage } from "@/api/client";

export type ChatNavigation = "startNew" | "select" | "popstate" | "firstSendSaved";

export function nextSessionKey(key: number, navigation: ChatNavigation): number {
  return navigation === "firstSendSaved" ? key : key + 1;
}

export interface OptimisticMessage {
  session: number;
  text: string;
  references: ConversationReference[];
  baseline: number;
  sentAt: string;
}

type MessageAuthor = "user" | "assistant" | "system";

export function messageAuthor(role: string): MessageAuthor {
  if (role === "user") return "user";
  if (role === "system") return "system";
  return "assistant";
}

export function userMessageCount(messages: readonly Pick<UiMessage, "role">[]): number {
  return messages.filter((message) => message.role === "user").length;
}

export function optimisticVisible(
  optimistic: OptimisticMessage | null,
  session: number,
  messages: readonly Pick<UiMessage, "role">[],
): boolean {
  if (!optimistic || optimistic.session !== session) return false;
  return userMessageCount(messages) <= optimistic.baseline;
}

export function shouldRestoreComposer(
  optimistic: Pick<OptimisticMessage, "baseline">,
  messagesAfter: readonly Pick<UiMessage, "role">[],
): boolean {
  return userMessageCount(messagesAfter) <= optimistic.baseline;
}

export function conversationOpenedByFailedSend(input: {
  startedId: string | null;
  knownIds: ReadonlySet<string> | null;
  sentAt: string;
  listed: readonly { id: string; created_at: string }[];
}): string | null {
  return input.startedId;
}

type TurnFailureCause =
  | {
      kind:
        | "provider_quota_exhausted"
        | "provider_rate_limited"
        | "provider_overloaded"
        | "provider_unreachable"
        | "tool_schema_invalid"
        | "provider_context_too_large"
        | "tenant_budget_exhausted"
        | "ai_access_missing";
      retryAt: string | null;
    }
  | { kind: "provider_timeout"; timeoutMs: number | null };

function causeKind(
  code: string,
  kind: unknown,
): Exclude<TurnFailureCause, { kind: "provider_timeout" }>["kind"] | null {
  switch (code) {
    case "llm_provider_limited":
      return kind === "quota_exhausted" ? "provider_quota_exhausted" : "provider_rate_limited";
    case "llm_tool_schema_invalid":
      return "tool_schema_invalid";
    case "llm_provider_unavailable":
      return kind === "overloaded" ? "provider_overloaded" : "provider_unreachable";
    case "llm_context_too_large":
      return "provider_context_too_large";
    case "llm_quota_exhausted":
      return "tenant_budget_exhausted";
    case "ai_access_missing":
      return "ai_access_missing";
    default:
      return null;
  }
}

export function turnFailureCause(
  failure:
    | { code?: string | null; kind?: unknown; retry_at?: unknown; timeout_ms?: unknown }
    | null
    | undefined,
): TurnFailureCause | null {
  if (failure?.code === "llm_timeout") {
    return {
      kind: "provider_timeout",
      timeoutMs: typeof failure.timeout_ms === "number" ? failure.timeout_ms : null,
    };
  }
  const kind = failure?.code ? causeKind(failure.code, failure.kind) : null;
  if (!kind) return null;
  const retryAt = typeof failure?.retry_at === "string" ? failure.retry_at : null;
  return { kind, retryAt };
}

export function recoverFailedSend(input: {
  activeId: string | null;
  openedId: string | null;
  optimistic: Pick<OptimisticMessage, "baseline">;
  messagesAfter: readonly Pick<UiMessage, "role">[] | null;
}): { switchTo: string | null; restoreComposer: boolean } {
  const after = input.messagesAfter ?? [];
  if (input.activeId) {
    return { switchTo: null, restoreComposer: shouldRestoreComposer(input.optimistic, after) };
  }
  if (!input.openedId) return { switchTo: null, restoreComposer: true };
  return {
    switchTo: input.openedId,
    restoreComposer: shouldRestoreComposer({ baseline: 0 }, after),
  };
}

export function optimisticUiMessage(optimistic: OptimisticMessage): UiMessage {
  return {
    id: `optimistic-${optimistic.session}-${optimistic.baseline}`,
    role: "user",
    parts: [
      {
        type: "text",
        text: optimistic.text,
        ...(optimistic.references.length > 0 ? { references: optimistic.references } : {}),
      },
    ],
    model: null,
    created_at: optimistic.sentAt,
  };
}

export function chatHeaderTitle(input: {
  title: string | null | undefined;
  listTitle: string | null | undefined;
  failed: boolean;
  activeId: string | null;
  startedHere: boolean;
  loaded: boolean;
}): { kind: "title"; text: string } | { kind: "new" | "untitled" | "unavailable" | "loading" } {
  if (input.title) return { kind: "title", text: input.title };
  if (input.listTitle) return { kind: "title", text: input.listTitle };
  if (input.failed) return { kind: "unavailable" };
  if (!input.activeId || input.startedHere) return { kind: "new" };
  return input.loaded ? { kind: "untitled" } : { kind: "loading" };
}

export function budgetPill(
  state: "ample" | "tightening" | "critical" | null | undefined,
): "tightening" | "critical" | null {
  return state === "tightening" || state === "critical" ? state : null;
}

export interface ChatOperation {
  session: number;
  startedId: string | null;
}

export function ownsChatOperation(
  active: object | null,
  operation: ChatOperation,
  session: number,
): boolean {
  return active === operation && operation.session === session;
}
