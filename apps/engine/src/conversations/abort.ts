import { readEnv } from "../env.ts";
import { logger } from "../logging/index.ts";
import { now } from "../utils/clock.ts";
import { isAbortError } from "./loop/usage.ts";

export const CONVERSATION_CANCELLED_REASON = "conversation_cancelled";

const REGISTRY = new Map<string, AbortController>();

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

export function hasConversationAbort(tenantId: string, conversationId: string): boolean {
  return REGISTRY.has(key(tenantId, conversationId));
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

export function isExpectedCancellation(err: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (isAbortError(err)) return true;
  if (signal.reason === CONVERSATION_CANCELLED_REASON) return true;
  return false;
}

export function __hasConversationAbort(tenantId: string, conversationId: string): boolean {
  if (readEnv("NODE_ENV") !== "test") {
    throw new Error(
      "__hasConversationAbort is test-only and must not be called outside NODE_ENV=test. " +
        "Use cancelConversationAbort from production code; the registry's slot state is not a public surface.",
    );
  }
  return REGISTRY.has(key(tenantId, conversationId));
}
