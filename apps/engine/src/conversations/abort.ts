// Process-local map: conversation_id -> AbortController for the active
// turn loop. POST /v1/conversations/:id/cancel looks the controller up
// here and fires `abort("conversation_cancelled")` so long-running
// previews and the surrounding streamText call stop promptly.

export const CONVERSATION_CANCELLED_REASON = "conversation_cancelled";

const REGISTRY = new Map<string, AbortController>();

export function registerConversationAbort(conversationId: string): AbortController {
  const ctrl = new AbortController();
  REGISTRY.set(conversationId, ctrl);
  return ctrl;
}

export function unregisterConversationAbort(conversationId: string, ctrl?: AbortController): void {
  const current = REGISTRY.get(conversationId);
  if (!current) return;
  if (ctrl && current !== ctrl) return;
  REGISTRY.delete(conversationId);
}

export function cancelConversationAbort(
  conversationId: string,
  reason = CONVERSATION_CANCELLED_REASON,
): boolean {
  const ctrl = REGISTRY.get(conversationId);
  if (!ctrl) return false;
  ctrl.abort(reason);
  return true;
}

export function mergeAbortSignals(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      ctrl.abort((signal as AbortSignal & { reason?: unknown }).reason ?? "aborted");
      return ctrl.signal;
    }
    signal.addEventListener(
      "abort",
      () => {
        ctrl.abort((signal as AbortSignal & { reason?: unknown }).reason ?? "aborted");
      },
      { once: true },
    );
  }
  return ctrl.signal;
}
