import { and, eq, inArray } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { conversations, type Executor } from "../../db/index.ts";
import { conversationSources } from "../core/conversation-status.ts";
import type { ConversationStatus } from "../types.ts";

interface ConversationTransition {
  tenant_id: string;
  conversation_id: string;
  to: ConversationStatus;
  from?: readonly ConversationStatus[];
  set?: Omit<PgUpdateSetSource<typeof conversations>, "status" | "id" | "tenant_id">;
}

export async function transitionConversation(
  tx: Executor,
  transition: ConversationTransition,
): Promise<typeof conversations.$inferSelect | null> {
  const sources = conversationSources(transition.to, transition.from);
  if (sources.length === 0) return null;
  const [row] = await tx
    .update(conversations)
    .set({ ...transition.set, status: transition.to })
    .where(
      and(
        eq(conversations.tenant_id, transition.tenant_id),
        eq(conversations.id, transition.conversation_id),
        inArray(conversations.status, sources),
      ),
    )
    .returning();
  return row ?? null;
}
