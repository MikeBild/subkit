import { PendingElicitationBlockedError } from "../conversations/service/shared.ts";
import { ConversationTurnInProgressError } from "../conversations/turns.ts";
import { HttpError } from "../http/errors.ts";

const CONVERSATION_TURN_ABORT_REASONS = [
  "conversation_turn_superseded",
  "conversation_cancelled",
] as const;

type ConversationTurnAbortReason = (typeof CONVERSATION_TURN_ABORT_REASONS)[number];

function conversationTurnAbortReasonOf(err: unknown): ConversationTurnAbortReason | null {
  return CONVERSATION_TURN_ABORT_REASONS.find((reason) => reason === err) ?? null;
}

export function mcpErrorCodeOf(err: unknown): string | undefined {
  if (
    err instanceof ConversationTurnInProgressError ||
    err instanceof PendingElicitationBlockedError ||
    err instanceof HttpError
  )
    return err.code;
  if (typeof err === "string") return conversationTurnAbortReasonOf(err) ?? undefined;
  return undefined;
}

export function toMcpErrorText(err: unknown): string {
  if (err instanceof ConversationTurnInProgressError) return `${err.code}: ${err.message}`;
  if (err instanceof PendingElicitationBlockedError) return `${err.code}: ${err.message}`;
  if (err instanceof HttpError) {
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  const abortReason = conversationTurnAbortReasonOf(err);
  if (abortReason) return `conversation_turn_aborted: ${abortReason}`;
  return String(err);
}
