// Process-local registry mapping (tenant_id, conversation_id) → active
// turn AbortController. POST /v1/conversations/:id/cancel looks the
// controller up here and fires `abort("conversation_cancelled")` so
// long-running previews and the surrounding streamText call stop
// promptly.
//
// **Tenant scoping.** The registry key carries the
// tenant id alongside the conversation id. Without it, a foreign
// tenant POSTing /v1/conversations/{id}/messages with another
// tenant's UUID would overwrite the legitimate registration: the auth
// + Zod gate validate the UUID's *shape*, not its tenant ownership;
// the tenant check happens inside `appendUserMessage`, after the
// route handler has already registered. Tenant-scoping the key means
// a cross-tenant probe lives in its own slot and cannot displace the
// rightful turn's controller.
//
// **Synchronous registration (A4).** The route handler must
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
// log line is expected on a fraction of cancels and the running turn
// drains its own budget. Tracked in docs/operators/observability.md (single-
// replica is the supported topology for the cancel surface today).
//
// **Reason coverage for `isExpectedCancellation`.** The two known
// cancel sources today:
//   1. `isAbortError(err)` — DOMException AbortError / TimeoutError,
//      plus Error/string messages whose word-bounded tokens hit
//      `\b(abort(?:ed)?|cancel(?:l?ed)?)\b`.
//   2. `signal.reason === CONVERSATION_CANCELLED_REASON` — the literal
//      reason this module's `cancelConversationAbort` issues.
// Any future call site that fires `ctrl.abort(otherReason)` —
// `"idle_timeout"`, `"client_disconnected"`, `"budget_exhausted"` —
// must extend `isExpectedCancellation` below. Falling through both
// prongs surfaces the abort as a 500 to the route handler.

import { logger } from "../logging/logger.ts";
import { now } from "../utils/clock.ts";
import { isAbortError } from "./loop/usage.ts";

export const CONVERSATION_CANCELLED_REASON = "conversation_cancelled";

const REGISTRY = new Map<string, AbortController>();

// Sampling cache for `cancel.no_controller`: maps the registry key to
// the last-emit timestamp. Multi-replica deploys without sticky
// routing fire `no_controller` on every cancel that lands on the
// wrong pod; UI races fire it when the route's `finally` already
// unregistered. Both are legitimate, expected paths — emitting once
// per (tenant, conv, second) is enough for an operator to see the
// signal without flooding logs. Cache trimmed opportunistically; in
// practice the entry count is bounded by concurrent active turns.
const NO_CONTROLLER_LOG_DEBOUNCE_MS = 5_000;
const NO_CONTROLLER_LAST_EMIT = new Map<string, number>();

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
    // status. Logged at `info` because both legitimate
    // paths fire it on every cancel: a `warn` would create false-alarm
    // SRE noise the moment a deployment scales horizontally without
    // sticky routing.
    //
    // Per-(tenant, conv) sampling at 5s windows:
    // a UI that retries cancel rapidly, or a multi-replica fan-out
    // where every cancel-arriving-on-the-wrong-pod fires the same
    // line, otherwise produces correlated log spam without adding
    // signal. The first emission in each window goes through; later
    // ones are dropped. SREs that need to detect a regression here
    // alert on `conversations.abort cancel.no_controller` count vs
    // turn cancels — a high ratio is the regression signal, and the
    // sampler doesn't suppress that.
    const k = key(tenantId, conversationId);
    const lastEmit = NO_CONTROLLER_LAST_EMIT.get(k) ?? 0;
    const t = now();
    if (t - lastEmit >= NO_CONTROLLER_LOG_DEBOUNCE_MS) {
      NO_CONTROLLER_LAST_EMIT.set(k, t);
      logger.info({
        module: "conversations.abort",
        action: "cancel.no_controller",
        msg: "cancel issued but no AbortController registered for conversation",
        tenant_id: tenantId,
        conversation_id: conversationId,
        reason,
      });
    }
    // Opportunistic trim — keeps the cache from growing unboundedly
    // when a deployment cycles through many short-lived conversations.
    if (NO_CONTROLLER_LAST_EMIT.size > 4096) {
      for (const [cacheKey, cacheTs] of NO_CONTROLLER_LAST_EMIT) {
        if (t - cacheTs >= NO_CONTROLLER_LOG_DEBOUNCE_MS) {
          NO_CONTROLLER_LAST_EMIT.delete(cacheKey);
        }
      }
    }
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

/**
 * Single-source-of-truth detector for "the turn was cancelled, not
 * errored." Used by the conversation loop's primary + fallback dispatch
 * catches; co-located with the registry + reason constant so a future
 * cancel source is added in exactly one place. See the header `Reason
 * coverage` block for the contract.
 *
 * Returns `true` iff the signal is aborted AND the error / signal-reason
 * matches one of the recognised cancel shapes.
 */
export function isExpectedCancellation(err: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (isAbortError(err)) return true;
  if (signal.reason === CONVERSATION_CANCELLED_REASON) return true;
  return false;
}

/**
 * test-only — do not import outside `*.test.ts`. Peeks at whether a
 * (tenant, conversation) slot has a live registration without aborting
 * it. Production code never calls this; `cancelConversationAbort` is
 * the canonical reader. Exposed so unit tests can pin invariants like
 * "the controller is still registered while the SSE callback is
 * running" without hooking the registry out via prototype inspection.
 *
 * Defence in depth: throws when called outside `NODE_ENV=test` to
 * surface a bad production import at first call, instead of letting
 * the function quietly leak the registry's slot state into a runtime
 * surface that wasn't designed for it.
 */
export function __hasConversationAbort(tenantId: string, conversationId: string): boolean {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "__hasConversationAbort is test-only and must not be called outside NODE_ENV=test. " +
        "Use cancelConversationAbort from production code; the registry's slot state is not a public surface.",
    );
  }
  return REGISTRY.has(key(tenantId, conversationId));
}

// `mergeAbortSignals` lives in `./_internal/abort-merge.ts` so the
// conversations barrel at `./index.ts` cannot accidentally re-export
// it. Loop.ts imports it directly.
