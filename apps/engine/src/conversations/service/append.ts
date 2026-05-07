// Append a user message and drive the next loop turn. Refuses with
// `PendingElicitationBlockedError` when an `ask_user_*` is still
// pending — the loop must resume via `respondElicitation` instead.

import { and, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { conversations } from "../../db/schema/index.ts";
import { log } from "../../logging/logger.ts";
import { runLoop } from "../loop.ts";
import type { ConversationPermissionMode } from "../types.ts";
import { getConversation } from "./get.ts";
import {
  type ConversationTurnOutcome,
  getStoredPermissionMode,
  normalizePermissionMode,
  PendingElicitationBlockedError,
  persistPermissionModeIfChanged,
} from "./shared.ts";

export interface AppendMessageParams {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  message: string;
  /** Optional user-supplied memory payload to attach to this turn. */
  memory?: string | null;
  /** Surface for per-variant prompts — threaded to runLoop. */
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web";
  /** Live-event emitter — enables SSE streaming. */
  onEvent?: Parameters<typeof runLoop>[0]["onEvent"];
  /** Real runtime context (engine_url, tenant_slug, actor email/role) — see runtime-context.ts. */
  runtime_context?: {
    engine_url?: string;
    tenant_slug?: string;
    actor_email?: string;
    actor_role?: string;
  };
  /** Client-supplied permission mode for this turn. */
  permission_mode?: ConversationPermissionMode | null;
  /** Pre-registered AbortController — see RunLoopParams.turn_abort_ctrl.
   *  Required as of #148: the HTTP route handler / MCP tool path
   *  registers on the synchronous frame of request-accept and threads
   *  through. The runLoop fallback that pre-#148 covered missing
   *  controllers has been retired. */
  turn_abort_ctrl: AbortController;
}

export async function appendUserMessage(
  p: AppendMessageParams,
  exec: Db,
): Promise<ConversationTurnOutcome> {
  const conv = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!conv) throw new Error("conversation not found");
  const explicitPermissionMode = normalizePermissionMode(p.permission_mode);
  const storedPermissionMode = getStoredPermissionMode(conv.draft);
  const effectivePermissionMode = explicitPermissionMode ?? storedPermissionMode;
  if (explicitPermissionMode && explicitPermissionMode !== storedPermissionMode) {
    await persistPermissionModeIfChanged({
      exec,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      draft: conv.draft,
      permission_mode: explicitPermissionMode,
    });
  }
  {
    const { listElicitationsForConversation } = await import("../elicitations.ts");
    const pending = (await listElicitationsForConversation(p.tenant_id, p.conversation_id, exec))
      .filter((elicitation) => elicitation.status === "pending")
      .at(0);
    if (pending) {
      throw new PendingElicitationBlockedError({
        id: pending.id,
        tool_name: pending.tool_name,
        summary: pending.summary,
      });
    }
  }
  log.conversation.appended({
    conversation_id: p.conversation_id,
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
    message_length: p.message.length,
    memory_included: typeof p.memory === "string",
  });
  // If a new memory payload arrived, persist it on the row and emit
  // an audit entry; otherwise reuse the last memory payload we stored.
  let effectiveMemory: string | null = null;
  if (typeof p.memory === "string") {
    await exec
      .update(conversations)
      .set({ memory: p.memory, updated_at: new Date() })
      .where(eq(conversations.id, p.conversation_id));
    effectiveMemory = p.memory;
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.CONVERSATION_MEMORY_INJECTED,
        resource_type: "conversation",
        resource_id: p.conversation_id,
        result: "success",
        metadata: { bytes: p.memory.length },
      },
      exec,
    );
  } else {
    // Reuse whatever was last persisted on the row.
    const [row] = await exec
      .select({ memory: conversations.memory, model: conversations.model })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
      .limit(1);
    effectiveMemory = row?.memory ?? null;
  }

  const result = await runLoop({
    db: exec,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    connector_id: conv.conversation.target_connector_id,
    workflow_id: conv.conversation.target_workflow_id,
    user_message: p.message,
    user_memory: effectiveMemory,
    model_override: conv.conversation.model,
    turn_abort_ctrl: p.turn_abort_ctrl,
    ...(p.surface ? { surface: p.surface } : {}),
    ...(p.onEvent ? { onEvent: p.onEvent } : {}),
    ...(p.runtime_context ? { runtime_context: p.runtime_context } : {}),
    ...(effectivePermissionMode ? { permission_mode: effectivePermissionMode } : {}),
  });
  const updated = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!updated) throw new Error("conversation disappeared");
  return { conversation: updated.conversation, result };
}
