import { and, asc, eq, inArray, notExists, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { conversationElicitations, conversationHidden, conversations } from "../db/schema/index.ts";
import { attentionHref, type Candidate } from "./attention-readers.ts";

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
  const byConversation = new Map<string, { created_at: Date; expires_at: Date }>();
  for (const row of pending) {
    const prior = byConversation.get(row.conversation_id);
    if (!prior || row.created_at > prior.created_at) byConversation.set(row.conversation_id, row);
  }
  return rows.map((row) => {
    const question = byConversation.get(row.id);
    return {
      source: "conversations",
      resource: { type: "conversation", id: row.id },
      item: {
        id: `conversation:${row.id}`,
        class: "stopped",
        severity: "urgent",
        kind: "conversation",
        subject: { kind: "conversation", id: row.id, name: row.title },
        reason: "awaiting_answer",
        trigger: null,
        cause_class: null,
        counts: {},
        since: (question?.created_at ?? row.updated_at).toISOString(),
        deadline: question?.expires_at.toISOString() ?? null,
        detail: null,
        actions: [
          {
            verb: "answer",
            href: attentionHref.conversation(row.id),
            primary: true,
            permission: "conversation:write",
          },
        ],
      },
    };
  });
}
