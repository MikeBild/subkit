import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  conversationMessages,
  conversations,
  type Executor,
  notTaskRunConversation,
  userSetupPreferences,
  users,
} from "../../db/index.ts";
import type { NoteOwnerScope } from "../sealing.ts";

export interface OwnMessageRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly text: string;
  readonly created_at: Date;
}

const messageText = sql<string>`coalesce(${conversationMessages.content}->>'text', '')`;
const typedByPerson = sql`${conversationMessages.content}->>'origin' IS NULL`;
const createdAtMs = sql`date_trunc('milliseconds', ${conversationMessages.created_at})`;
const notATaskRun = notTaskRunConversation();

function ownMessages(owner: NoteOwnerScope) {
  return and(
    eq(conversationMessages.tenant_id, owner.tenant_id),
    eq(conversations.tenant_id, owner.tenant_id),
    eq(conversations.owner_id, owner.user_id),
    eq(conversationMessages.role, "user"),
    typedByPerson,
    notATaskRun,
  );
}

export async function listOwnMessagesAfter(
  db: Executor,
  owner: NoteOwnerScope,
  after: Date | null,
  limit: number,
): Promise<OwnMessageRow[]> {
  return db
    .select({
      id: conversationMessages.id,
      conversation_id: conversationMessages.conversation_id,
      text: messageText,
      created_at: conversationMessages.created_at,
    })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversations.id, conversationMessages.conversation_id))
    .where(
      and(
        ownMessages(owner),
        after ? sql`${createdAtMs} > ${after.toISOString()}::timestamptz` : undefined,
      ),
    )
    .orderBy(conversationMessages.created_at, conversationMessages.id)
    .limit(limit);
}

export async function latestOwnMessages(
  db: Executor,
  owner: NoteOwnerScope,
  conversation_id: string,
  limit: number,
): Promise<OwnMessageRow[]> {
  const rows = await db
    .select({
      id: conversationMessages.id,
      conversation_id: conversationMessages.conversation_id,
      text: messageText,
      created_at: conversationMessages.created_at,
    })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversations.id, conversationMessages.conversation_id))
    .where(and(ownMessages(owner), eq(conversations.id, conversation_id)))
    .orderBy(desc(conversationMessages.created_at), desc(conversationMessages.id))
    .limit(limit);
  return rows.reverse();
}

export async function listPeopleWithNewMessages(
  db: Executor,
  tenant_id: string,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ user_id: users.id })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversations.id, conversationMessages.conversation_id))
    .innerJoin(
      users,
      and(eq(users.id, conversations.owner_id), eq(users.tenant_id, conversations.tenant_id)),
    )
    .leftJoin(
      userSetupPreferences,
      and(
        eq(userSetupPreferences.tenant_id, users.tenant_id),
        eq(userSetupPreferences.user_id, users.id),
      ),
    )
    .where(
      and(
        eq(conversationMessages.tenant_id, tenant_id),
        eq(conversations.tenant_id, tenant_id),
        eq(conversationMessages.role, "user"),
        typedByPerson,
        notATaskRun,
        eq(users.status, "active"),
        isNull(users.deleted_at),
        sql`coalesce(${userSetupPreferences.save_new_notes}, true)`,
        sql`(${userSetupPreferences.notes_learned_through} IS NULL OR ${createdAtMs} > ${userSetupPreferences.notes_learned_through})`,
      ),
    )
    .limit(limit);
  return rows.map((row) => row.user_id);
}
