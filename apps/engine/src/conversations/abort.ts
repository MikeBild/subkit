// Process-local registry mapping (tenant_id, conversation_id) → active
// turn AbortController. POST /v1/conversations/:id/cancel looks the
// controller up here and fires `abort("conversation_cancelled")` so
// long-running previews and the surrounding streamText call stop
// promptly.
//
// **Tenant scoping (#147 review C1).** The registry key carries the
// tenant id alongside the conversation id. Without it, a foreign
// tenant POSTing /v1/conversations/{id}/messages with another
// tenant's UUID would overwrite the legitimate registration: the auth
// + Zod gate validate the UUID's *shape*, not its tenant ownership;
// the tenant check happens inside `appendUserMessage`, after the
// route handler has already registered. Tenant-scoping the key means
// a cross-tenant probe lives in its own slot and cannot displace the
// rightful turn's controller.
//
// **Synchronous registration (#147 / A4).** The route handler must
// call `registerConversationAbort` on the synchronous frame of
// request-accept, before any await. Registering inside the loop body
// (the pre-A4 location) re-opens the race the cancel route silently
// lost.
//
// **Process-local — multi-replica caveat.** The registry lives in the
// engine process. A cancel only finds the running turn when both
// requests land on the same replica. Operators running a
// horizontally-scaled fleet must front the engine with sticky routing
// keyed on `conversation_id` (or stand up a shared store) before
// scaling past one replica; otherwise the `cancel.no_controller`
// warn is expected on a fraction of cancels and the running turn
// drains its own budget. Tracked in docs/08-operations.md (single-
// replica is the supported topology for the cancel surface today).

import { logger } from "../logging/logger.ts";

export const CONVERSATION_CANCELLED_REASON = "conversation_cancelled";

const REGISTRY = new Map<string, AbortController>();

function key(tenantId: string, conversationId: string): string {
  return `${tenantId}:${conversationId}`;
}

export function registerConversationAbort(
  tenantId: string,
  conversationId: string,
): AbortController {
  const ctrl = new AbortController();
  REGISTRY.set(key(tenantId, conversationId), ctrl);
  return ctrl;
}

export function unregisterConversationAbort(
  tenantId: string,
  conversationId: string,
  ctrl?: AbortController,
): void {
  const k = key(tenantId, conversationId);
  const current = REGISTRY.get(k);
  if (!current) return;
  if (ctrl && current !== ctrl) return;
  REGISTRY.delete(k);
}

export function cancelConversationAbort(
  tenantId: string,
  conversationId: string,
  reason = CONVERSATION_CANCELLED_REASON,
): boolean {
  const ctrl = REGISTRY.get(key(tenantId, conversationId));
  if (!ctrl) {
    // No controller registered. Two known-legitimate paths:
    //   - The turn already completed (controller unregistered in
    //     the route's finally) — common when a UI fires cancel
    //     after the response has already streamed.
    //   - Multi-replica deploy without sticky routing — the cancel
    //     hit a different pod than the turn (see header note).
    // Either way, the DB row write in cancelConversation runs
    // tenant-scoped and is the source of truth for the conversation
    // status. The warn here is observability for the in-memory layer,
    // not a correctness signal.
    logger.warn({
      module: "conversations.abort",
      action: "cancel.no_controller",
      msg: "cancel issued but no AbortController registered for conversation",
      tenant_id: tenantId,
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
    tenant_id: tenantId,
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
