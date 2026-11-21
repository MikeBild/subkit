import { and, asc, eq, inArray, notExists, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { conversationElicitations, conversationHidden, conversations } from "../db/schema/index.ts";
import { attentionHref, type Candidate } from "./attention-readers.ts";
import { conversationAttentionItem, type OpenQuestion } from "./core/conversation-item.ts";

export async function readOwnConversations(
  db: Db,
  principal: ResolvedPrincipal,
): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      updated_at: conversations.updated_at,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenant_id, principal.tenant_id),
        eq(conversations.owner_id, principal.id),
        eq(conversations.status, "awaiting_input"),
        notExists(
          db
            .select({ one: sql`1` })
            .from(conversationHidden)
            .where(
              and(
                eq(conversationHidden.tenant_id, principal.tenant_id),
                eq(conversationHidden.conversation_id, conversations.id),
                eq(conversationHidden.user_id, principal.id),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(conversations.updated_at));
  if (rows.length === 0) return [];
  const pending = await db
    .select({
      conversation_id: conversationElicitations.conversation_id,
      created_at: conversationElicitations.created_at,
      expires_at: conversationElicitations.expires_at,
      local: sql<boolean>`${conversationElicitations.input} ? 'device'`,
    })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, principal.tenant_id),
        inArray(
          conversationElicitations.conversation_id,
          rows.map((row) => row.id),
        ),
        eq(conversationElicitations.status, "pending"),
      ),
    );
  const byConversation = new Map<string, OpenQuestion>();
  for (const row of pending) {
    const prior = byConversation.get(row.conversation_id);
    if (!prior || row.created_at > prior.created_at) byConversation.set(row.conversation_id, row);
  }
  return rows.map((row) => ({
    source: "conversations",
    resource: { type: "conversation", id: row.id },
    item: conversationAttentionItem(
      row,
      byConversation.get(row.id),
      attentionHref.conversation(row.id),
    ),
  }));
}
