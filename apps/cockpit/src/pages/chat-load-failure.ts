import { ApiError } from "@/api/client";

/**
 * Why a conversation could not be opened, as far as the reader can act on it.
 *
 * `missing` — the engine answered 404 or 403: the conversation does not exist
 * or is not the reader's. Retrying asks the same question and gets the same
 * answer, so the way on is the list or a new conversation, not a retry button.
 * `transient` — anything else (a 5xx, the network): trying again can help.
 *
 * The page used to tell an unknown conversation to "reload the page or try
 * again in a moment" — advice that could never work.
 */
export type ConversationFailure = "missing" | "transient";

export function conversationFailureKind(error: unknown): ConversationFailure {
  return error instanceof ApiError && (error.status === 404 || error.status === 403)
    ? "missing"
    : "transient";
}

/**
 * React Query's retry for the conversation read. A refusal is final at once —
 * retrying it only held the page on the transient wording for seven seconds
 * before it flipped. A transient failure keeps the default three attempts.
 */
export function retryConversationRead(failureCount: number, error: unknown): boolean {
  return conversationFailureKind(error) === "transient" && failureCount < 3;
}
