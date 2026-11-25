import { and, eq } from "drizzle-orm";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import { conversations, type Executor, notTaskRunConversation } from "../../db/index.ts";
import type { ConversationVisibility } from "../core/access.ts";
import { rowToRecord } from "../service/shared.ts";
import type { ConversationRecord } from "../types.ts";

export async function storeConversationVisibility(
  exec: Executor,
  p: {
    tenant_id: string;
    conversation_id: string;
    actor_id: string;
    from: ConversationVisibility;
    to: ConversationVisibility;
  },
): Promise<ConversationRecord | null> {
  const [row] = await exec
    .update(conversations)
    .set({ visibility: p.to })
    .where(
      and(
        eq(conversations.tenant_id, p.tenant_id),
        eq(conversations.id, p.conversation_id),
        eq(conversations.visibility, p.from),
      ),
    )
    .returning();
  if (!row) return null;
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: "user",
      actor_id: p.actor_id,
      action: p.to === "team" ? AuditAction.CONVERSATION_SHARED : AuditAction.CONVERSATION_UNSHARED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "success",
      metadata: { from: p.from, to: p.to },
    },
    exec,
  );
  return rowToRecord(row);
}

export async function shareChannelThread(
  exec: Executor,
  tenant_id: string,
  conversation_id: string,
): Promise<boolean> {
  const rows = await exec
    .update(conversations)
    .set({ visibility: "team" })
    .where(
      and(
        eq(conversations.tenant_id, tenant_id),
        eq(conversations.id, conversation_id),
        eq(conversations.visibility, "private"),
        eq(conversations.surface, "chat"),
        notTaskRunConversation(),
      ),
    )
    .returning({ id: conversations.id });
  return rows.length > 0;
}
