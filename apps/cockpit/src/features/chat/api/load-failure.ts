import { ApiError } from "@/api/client";

type ConversationFailure = "missing" | "transient";

export function conversationFailureKind(error: unknown): ConversationFailure {
  return error instanceof ApiError && (error.status === 404 || error.status === 403)
    ? "missing"
    : "transient";
}

export function retryConversationRead(failureCount: number, error: unknown): boolean {
  return conversationFailureKind(error) === "transient" && failureCount < 3;
}
