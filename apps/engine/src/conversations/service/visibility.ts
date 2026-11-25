import { and, eq } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { conversations } from "../../db/schema/index.ts";
import { notTaskRunConversation } from "../../db/task-run-conversations.ts";
import type { ConversationVisibility } from "../core/access.ts";
import type { ConversationRecord } from "../types.ts";
import { rowToRecord } from "./shared.ts";

/**
 * Stores a visibility move decided by moveConversationVisibility. The
 * `from` guard makes a concurrent move lose instead of writing twice.
 */
export async function storeConversationVisibility(
  exec: Executor,
  p: {
    tenant_id: string;
    conversation_id: string;
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
  return row ? rowToRecord(row) : null;
}

/**
 * A chat thread in a channel is shared with the team. Older channel threads
 * were stored private; the dispatcher shares them on their next message.
 */
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
