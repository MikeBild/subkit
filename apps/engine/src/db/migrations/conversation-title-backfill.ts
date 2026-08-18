// One-shot code backfill: name every conversation that predates auto-titling.
//
// Auto-titling (`conversations/title.ts`) only fires when a user message is
// appended, so a purely lazy rollout would leave every dormant conversation
// untitled forever — and dormant conversations are the bulk of the list a
// person scrolls. This walks them once at boot.
//
// It is TypeScript rather than SQL on purpose: a SQL backfill would have to
// re-implement `deriveConversationTitle`'s sentinel stripping and clipping, and
// the copy would drift from the live path the first time either changed. Its
// idempotency marker is one row in `data_migrations`; a present marker makes
// the next boot a no-op.
//
// Failures never break boot — the caller in `db/migrate.ts` wraps it, and the
// marker stays unset so the next boot retries.

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { deriveConversationTitle } from "../../conversations/title.ts";
import { logger } from "../../logging/logger.ts";
import type { Db } from "../client.ts";
import { conversationMessages, conversations, dataMigrations } from "../schema/index.ts";

export const CONVERSATION_TITLE_BACKFILL_NAME = "conversation_title_v1";

/** Rows per pass. Bounded so a large tenant cannot hold the boot phase. */
const BATCH = 500;

export interface ConversationTitleBackfillReport {
  /** True when the marker row already existed — nothing was scanned. */
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

    // One query for the batch's first user message, not one per conversation.
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
      // Same `title IS NULL` guard as the live path: a title written by a
      // concurrent request while this walk runs wins over the backfill's.
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
