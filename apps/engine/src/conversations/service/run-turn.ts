// The `runLoop` tail of a conversation turn, extracted so it can run in
// two places without code duplication:
//
//   1. Inline, right after `createConversation` / `appendUserMessage`
//      on the HTTP+SSE surface — the streaming `onEvent` is threaded
//      straight through, so that surface does not regress.
//   2. Inside the `conversation.run-turn` pg-boss worker for the MCP
//      async-Tasks path, where the `tools/call` returned long ago.
//
// `createConversation` / `appendUserMessage` own row insert + audit +
// validation + the `conversation_messages` user-row insert. This
// function owns ONLY the model loop + the terminal reload + the
// `CONVERSATION_COMMITTED` audit on a committed turn.

import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import type { ElicitationBridge } from "../elicitation-bridge.ts";
import { tryFastPath } from "../fast-path.ts";
import { type RunLoopResult, runLoop } from "../loop.ts";
import type { ConversationPermissionMode } from "../types.ts";
import { getConversation } from "./get.ts";
import { type ConversationTurnOutcome, getStoredPermissionMode } from "./shared.ts";

export interface RunConversationTurnParams {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  /**
   * The user message that drives this turn. The caller has ALREADY
   * inserted the `conversation_messages` user row — `runLoop` is told
   * not to insert it again. `null` only for a resume with no new user
   * text (handled by `respondElicitation`, not this function).
   */
  user_message: string;
  /** Memory payload persisted on the conversation row, if any. */
  user_memory?: string | null;
  /** Permission mode resolved by the caller; falls back to the stored one. */
  permission_mode?: ConversationPermissionMode | null;
  /** Live-event emitter — keeps the HTTP/SSE surface streaming. */
  onEvent?: Parameters<typeof runLoop>[0]["onEvent"];
  /** Surface for per-variant prompts. */
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web";
  /** Real runtime context (engine_url, tenant_slug, actor email/role). */
  runtime_context?: {
    engine_url?: string;
    tenant_slug?: string;
    actor_email?: string;
    actor_role?: string;
  };
  /** Pre-registered AbortController for this turn's runLoop. */
  turn_abort_ctrl: AbortController;
  /** Client-side opt-out for the next-message preview frame. */
  next_suggestion_suppress?: boolean;
  /**
   * MCP-native elicitation bridge — present only for a synchronous MCP
   * `tools/call`. A backgrounded turn (the worker) passes nothing: it
   * has no live session, so input-collecting tools take the DB-pause
   * path and the conversation goes `awaiting_input`.
   */
  elicitationBridge?: ElicitationBridge;
  /**
   * Resolved principal — threaded through so the fast-path matcher can
   * enforce the same RBAC / confirm-before-execution gate the LLM tools
   * use (`gateTenantToolCall`). Absent on the MCP-worker resume path
   * where no live HTTP principal exists; in that case the fast-path
   * matcher short-circuits to the LLM loop so confirmation discipline
   * stays correct.
   */
  principal?: ResolvedPrincipal | null;
}

/**
 * Run the model loop for a turn whose user message row is already
 * persisted. Reloads the conversation afterwards and emits the
 * `CONVERSATION_COMMITTED` audit row when the turn committed a
 * workflow.
 */
export async function runConversationTurn(
  p: RunConversationTurnParams,
  exec: Db,
): Promise<ConversationTurnOutcome> {
  const conv = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!conv) throw new Error("conversation not found");
  const effectivePermissionMode = p.permission_mode ?? getStoredPermissionMode(conv.draft);

  // Fast-path matcher: deterministic intents (list_*, run <slug>,
  // inspect execution <uuid>) skip the LLM turn entirely. The matcher
  // persists the same tool-call + assistant-message rows the LLM loop
  // would produce, then short-circuits with `RunLoopResult`-shaped
  // outcome so HTTP + MCP callers see the same envelope.
  if (p.principal && p.user_message) {
    const hit = await tryFastPath({
      db: exec,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      actor_id: p.actor_id,
      principal: p.principal,
      user_message: p.user_message,
    });
    if (hit) {
      if (p.onEvent) {
        for (const ev of hit.events) p.onEvent(ev);
      }
      const fastResult: RunLoopResult = {
        events: hit.events,
        status: hit.status,
        ...(hit.pending_elicitation_id
          ? { pending_elicitation_id: hit.pending_elicitation_id }
          : {}),
      };
      const updated = await getConversation(p.tenant_id, p.conversation_id, exec);
      if (!updated) throw new Error("conversation disappeared");
      return { conversation: updated.conversation, result: fastResult };
    }
  }

  const result = await runLoop({
    db: exec,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    ...(p.principal ? { principal: p.principal } : {}),
    connector_id: conv.conversation.target_connector_id,
    workflow_id: conv.conversation.target_workflow_id,
    user_message: p.user_message,
    user_message_persisted: true,
    user_memory: p.user_memory ?? null,
    model_override: conv.conversation.model,
    turn_abort_ctrl: p.turn_abort_ctrl,
    ...(p.surface ? { surface: p.surface } : {}),
    ...(p.onEvent ? { onEvent: p.onEvent } : {}),
    ...(p.runtime_context ? { runtime_context: p.runtime_context } : {}),
    ...(effectivePermissionMode ? { permission_mode: effectivePermissionMode } : {}),
    ...(p.next_suggestion_suppress !== undefined
      ? { next_suggestion_suppress: p.next_suggestion_suppress }
      : {}),
    ...(p.elicitationBridge ? { elicitationBridge: p.elicitationBridge } : {}),
  });

  const updated = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!updated) throw new Error("conversation disappeared");

  if (result.status === "committed" && result.committed_workflow_id) {
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.CONVERSATION_COMMITTED,
        resource_type: "conversation",
        resource_id: p.conversation_id,
        result: "success",
        metadata: { workflow_id: result.committed_workflow_id },
      },
      exec,
    );
  }

  return { conversation: updated.conversation, result };
}
