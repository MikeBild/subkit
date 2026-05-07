// Process-local map: conversation_id -> AbortController for the active
// turn loop. POST /v1/conversations/:id/cancel looks the controller up
// here and fires `abort("conversation_cancelled")` so long-running
// previews and the surrounding streamText call stop promptly.
//
// Registration must happen on the synchronous frame of the request
// handler so a cancel that arrives in the first ~40 ms of the turn
// finds a controller. Registering inside the loop body (after the
// first await) reopens the race that was closed in #146 / A4.

import { logger } from "../logging/logger.ts";

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
  if (!ctrl) {
    // No controller registered means the cancel raced with the request
    // and lost. With A4 in place this should be impossible — log a
    // warning so any regression that reopens the race is visible.
    logger.warn({
      module: "conversations.abort",
      action: "cancel.no_controller",
      msg: "cancel issued but no AbortController registered for conversation — race regression?",
      conversation_id: conversationId,
      reason,
    });
    return false;
  }
  ctrl.abort(reason);
  logger.info({
    module: "conversations.abort",
    action: "turn.cancelled",
    msg: "conversation turn cancelled via cancel route",
    conversation_id: conversationId,
    reason,
  });
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
