import { and, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { conversationMessages, conversations } from "../../db/schema/index.ts";
import { log } from "../../logging/logger.ts";
import { undoLastSnapshot } from "../draft.ts";
import type { ConversationRecord, DraftDocument } from "../types.ts";
import { getConversation } from "./get.ts";
import { rowToRecord } from "./shared.ts";

export interface CompactConversationParams {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  keep_last?: number;
}

export interface CompactConversationResult {
  conversation: ConversationRecord;
  summary: string;
  messages_collapsed: number;
}

export async function compactConversation(
  p: CompactConversationParams,
  exec: Db,
): Promise<CompactConversationResult> {
  const keepLast = Math.max(0, Math.min(p.keep_last ?? 4, 50));
  const conv = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!conv) throw new Error("conversation not found");

  const total = conv.messages.length;
  const collapseCount = Math.max(0, total - keepLast);

  let summary = "";
  if (collapseCount > 0) {
    const firstUser = conv.messages.find((m) => m.role === "user");
    const lastAssistant = [...conv.messages].reverse().find((m) => m.role === "assistant");
    const firstText =
      firstUser && typeof firstUser.content === "object" && firstUser.content !== null
        ? JSON.stringify((firstUser.content as { text?: string }).text ?? firstUser.content).slice(
            0,
            200,
          )
        : "";
    const lastText =
      lastAssistant && typeof lastAssistant.content === "object" && lastAssistant.content !== null
        ? JSON.stringify(
            (lastAssistant.content as { text?: string }).text ?? lastAssistant.content,
          ).slice(0, 200)
        : "";
    summary =
      `Compacted ${collapseCount} earlier message(s). ` +
      (firstText ? `Opened with: ${firstText}. ` : "") +
      (lastText ? `Most recent assistant turn: ${lastText}` : "");

    await exec.insert(conversationMessages).values({
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      role: "system",
      content: { kind: "compacted", summary, collapsed: collapseCount },
    });
  }

  const [updated] = await exec
    .update(conversations)
    .set({ updated_at: new Date() })
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .returning();
  if (!updated) throw new Error("conversation disappeared");

  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_id ? "user" : "system",
      actor_id: p.actor_id,
      action: AuditAction.CONVERSATION_COMPACTED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "success",
      metadata: { collapsed: collapseCount, kept: Math.min(keepLast, total) },
    },
    exec,
  );

  log.conversation.compacted({
    conversation_id: p.conversation_id,
    collapsed: collapseCount,
    kept: Math.min(keepLast, total),
    total,
  });

  return {
    conversation: rowToRecord(updated),
    summary,
    messages_collapsed: collapseCount,
  };
}

export async function undoLastDraftMutation(
  tenant_id: string,
  conversation_id: string,
  exec: Db,
): Promise<DraftDocument> {
  return undoLastSnapshot(tenant_id, conversation_id, exec);
}
