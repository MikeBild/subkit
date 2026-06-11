// Append a user message and persist it. Refuses with
// `PendingElicitationBlockedError` when an `ask_user_*` is still
// pending — the loop must resume via `respondElicitation` instead.
//
// This function STOPS after persisting the message row + the memory
// side-effects. The model loop runs via `runConversationTurn` (see
// ./run-turn.ts), called inline by the HTTP/SSE route or in the
// `conversation.run-turn` pg-boss worker for the MCP async-Tasks path.

import { and, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { conversations } from "../../db/schema/index.ts";
import { log } from "../../logging/logger.ts";
import { findSecretSpans, scrubString } from "../../logging/scrub-secrets.ts";
import { resolveAttachmentSlugsInText } from "../attachments.ts";
import { appendMessage } from "../persist.ts";
import { captureDraftCredentialFromChatText } from "../persistence/auto-persist/credential-cache.ts";
import type { ConversationPermissionMode, ConversationRecord } from "../types.ts";
import { getConversation } from "./get.ts";
import {
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
  /** Client-supplied permission mode for this turn. */
  permission_mode?: ConversationPermissionMode | null;
}

export interface AppendMessageResult {
  conversation: ConversationRecord;
  /** The rewritten user message (attachment slugs resolved). The row
   * is already persisted; handed to `runConversationTurn` so the turn
   * does not re-insert it. */
  message: string;
  /**
   * The `conversation_messages` row id of the persisted user message.
   * The MCP async-Tasks handler pins this onto the `mcp_tasks` row so
   * the worker runs the turn on THIS message even when another turn
   * appends concurrently.
   */
  message_id: string;
  /** Memory payload effective for the turn. */
  user_memory: string | null;
}

/**
 * Validate the conversation, persist the user message row + memory
 * side-effects, and return the data the turn needs. Does NOT run the
 * model loop — the caller drives the turn via `runConversationTurn`.
 */
export async function appendUserMessage(
  p: AppendMessageParams,
  exec: Db,
): Promise<AppendMessageResult> {
  const conv = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!conv) throw new Error("conversation not found");
  const explicitPermissionMode = normalizePermissionMode(p.permission_mode);
  const storedPermissionMode = getStoredPermissionMode(conv.draft);
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
        // Carry the full elicitation so a client that raced a prompt
        // against this dialog can re-render and resolve it instead of
        // deadlocking.
        tool_call_id: pending.tool_call_id,
        input: pending.input,
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
      .select({ memory: conversations.memory })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
      .limit(1);
    effectiveMemory = row?.memory ?? null;
  }

  // Persist the user-message row before the turn runs (the MCP worker
  // reads it back; the HTTP/SSE route hands the text to
  // `runConversationTurn` directly). Both pass `user_message_persisted`
  // into `runLoop` so the loop does not double-insert.
  const rewrite = await resolveAttachmentSlugsInText(p.message, {
    db: exec,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
  });

  // Secret scrub + capture chokepoint (user decision): a pasted
  // secret never persists raw and never reaches the model raw — but it
  // is not lost either. When the conversation has an auth-required
  // connector draft, the secret is captured into the in-memory draft
  // credential cache (conversation-scoped) and the scrubbed text gets a
  // marker telling the agent to probe instead of re-collecting. With no
  // unambiguous mapping the text is scrubbed only — the agent routes to
  // the password form per prompt rule. The returned in-flight `message`
  // equals the persisted row; `persist.ts appendMessage` re-scrubs as
  // idempotent defense-in-depth underneath.
  let persistedText = rewrite.text;
  if (findSecretSpans(persistedText).length > 0) {
    const draftConnector = conv.draft?.connector ?? null;
    const authType = draftConnector?.auth_type ?? null;
    let capturedMode: string | null = null;
    if (draftConnector && authType != null && authType !== "none") {
      const capture = await captureDraftCredentialFromChatText({
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        rawText: persistedText,
        connector: draftConnector,
        db: exec,
      });
      if (capture.captured && capture.mode) capturedMode = capture.mode;
    }
    persistedText = scrubString(persistedText);
    if (capturedMode) {
      persistedText += ` [secret captured: cached as draft credential (mode=${capturedMode}) — do not re-collect; probe directly]`;
    }
  }

  const messageId = await appendMessage(exec, p.tenant_id, p.conversation_id, "user", {
    text: persistedText,
  });

  return {
    conversation: conv.conversation,
    message: persistedText,
    message_id: messageId,
    user_memory: effectiveMemory,
  };
}
