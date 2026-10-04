import { and, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { conversations } from "../../db/schema/index.ts";
import { log } from "../../logging/logger.ts";
import { findSecretSpans, scrubString } from "../../logging/scrub-secrets.ts";
import { resolveAttachmentSlugsInText } from "../attachments.ts";
import { appendMessage } from "../persist.ts";
import { captureDraftCredentialFromChatText } from "../persistence/auto-persist/credential-cache.ts";
import type { ConversationReference } from "../references.ts";
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
  principal?: ResolvedPrincipal | null;
  message: string;
  references?: ConversationReference[] | null;
  memory?: string | null;
  permission_mode?: ConversationPermissionMode | null;
}

export interface AppendMessageResult {
  conversation: ConversationRecord;
  message: string;
  message_id: string;
  references: ConversationReference[] | null;
  user_memory: string | null;
}

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
    const [row] = await exec
      .select({ memory: conversations.memory })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
      .limit(1);
    effectiveMemory = row?.memory ?? null;
  }

  const rewrite = await resolveAttachmentSlugsInText(p.message, {
    db: exec,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    ...(p.principal !== undefined ? { principal: p.principal } : {}),
  });

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

  const references = p.references && p.references.length > 0 ? p.references : null;
  const messageId = await appendMessage(exec, p.tenant_id, p.conversation_id, "user", {
    text: persistedText,
    ...(references ? { references } : {}),
  });

  return {
    conversation: conv.conversation,
    message: persistedText,
    message_id: messageId,
    references,
    user_memory: effectiveMemory,
  };
}
