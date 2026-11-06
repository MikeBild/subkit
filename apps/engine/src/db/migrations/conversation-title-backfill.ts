import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { deriveConversationTitle } from "../../conversations/title.ts";
import { logger } from "../../logging/logger.ts";
import type { Db } from "../client.ts";
import { conversationMessages, conversations, dataMigrations } from "../schema/index.ts";

export const CONVERSATION_TITLE_BACKFILL_NAME = "conversation_title_v1";

const BATCH = 500;

export interface ConversationTitleBackfillReport {
  skipped: boolean;
  scanned: number;
  titled: number;
}

export async function runConversationTitleBackfill(
  db: Db,
): Promise<ConversationTitleBackfillReport> {
  const marker = await db
    .select({ name: dataMigrations.name })
    .from(dataMigrations) // tenant-filter:exempt — boot data-migration ledger; markers are instance-global by design
    .where(eq(dataMigrations.name, CONVERSATION_TITLE_BACKFILL_NAME))
    .limit(1);
  if (marker.length > 0) return { skipped: true, scanned: 0, titled: 0 };

  let scanned = 0;
  let titled = 0;
  let cursor: string | null = null;

  for (;;) {
    const conds = [isNull(conversations.title)];
    if (cursor) conds.push(sql`${conversations.id} > ${cursor}`);
    const batch = await db
      .select({ id: conversations.id, tenant_id: conversations.tenant_id })
      .from(conversations) // tenant-filter:exempt — cross-tenant boot backfill
      .where(and(...conds))
      .orderBy(asc(conversations.id))
      .limit(BATCH);
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]?.id ?? null;
    scanned += batch.length;

    const ids = batch.map((row) => row.id);
    const messages = await db
      .select({
        conversation_id: conversationMessages.conversation_id,
        content: conversationMessages.content,
      })
      .from(conversationMessages) // tenant-filter:exempt — cross-tenant boot backfill
      .where(
        and(
          inArray(conversationMessages.conversation_id, ids),
          eq(conversationMessages.role, "user"),
        ),
      )
      .orderBy(asc(conversationMessages.created_at));

    const firstUserMessage = new Map<string, unknown>();
    for (const message of messages) {
      if (firstUserMessage.has(message.conversation_id)) continue;
      firstUserMessage.set(message.conversation_id, message.content);
    }

    for (const row of batch) {
      const title = deriveConversationTitle(firstUserMessage.get(row.id));
      if (!title) continue;
      const updated = await db
        .update(conversations)
        .set({ title })
        .where(
          and(
            eq(conversations.tenant_id, row.tenant_id),
            eq(conversations.id, row.id),
            isNull(conversations.title),
          ),
        )
        .returning({ id: conversations.id });
      if (updated.length > 0) titled += 1;
    }
  }

  await db
    .insert(dataMigrations)
    .values({ name: CONVERSATION_TITLE_BACKFILL_NAME })
    .onConflictDoNothing();

  logger.info({
    module: "db",
    action: "conversation.title_backfill.completed",
    msg: "conversation title backfill finished",
    scanned,
    titled,
  });

  return { skipped: false, scanned, titled };
}
