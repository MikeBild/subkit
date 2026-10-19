import { ConversationTurnInProgressError } from "../conversations/turns.ts";
import { HttpError } from "../http/errors.ts";

export function toMcpErrorText(err: unknown): string {
  if (err instanceof ConversationTurnInProgressError) return `${err.code}: ${err.message}`;
  if (err instanceof HttpError) {
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
