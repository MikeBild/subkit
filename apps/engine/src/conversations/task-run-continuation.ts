export const TASK_RUN_CONTINUATION_ORIGIN = "task_run_continuation";

export type ConversationMessageOrigin = typeof TASK_RUN_CONTINUATION_ORIGIN;

export function messageOrigin(content: unknown): ConversationMessageOrigin | null {
  return typeof content === "object" &&
    content !== null &&
    (content as { origin?: unknown }).origin === TASK_RUN_CONTINUATION_ORIGIN
    ? TASK_RUN_CONTINUATION_ORIGIN
    : null;
}
