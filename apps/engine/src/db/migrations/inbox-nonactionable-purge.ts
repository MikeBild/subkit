import { eq } from "drizzle-orm";
import { logger } from "../../logging/index.ts";
import type { Db } from "../client.ts";
import { cliNotificationInbox, dataMigrations } from "../schema/index.ts";

export const INBOX_NONACTIONABLE_PURGE_NAME = "inbox_nonactionable_purge_v1";

export interface InboxPurgeReport {
  skipped: boolean;
  deleted: number;
}

export async function runInboxNonActionablePurge(db: Db): Promise<InboxPurgeReport> {
  const marker = await db
    .select({ name: dataMigrations.name })
    .from(dataMigrations) // tenant-filter:exempt — boot data-migration ledger; markers are instance-global by design
    .where(eq(dataMigrations.name, INBOX_NONACTIONABLE_PURGE_NAME))
    .limit(1);
  if (marker.length > 0) return { skipped: true, deleted: 0 };

  const removed = await db
    .delete(cliNotificationInbox) // tenant-filter:exempt — cross-tenant one-shot purge of rows that are not tasks
    .where(eq(cliNotificationInbox.actionable, false))
    .returning({ id: cliNotificationInbox.id });

  await db
    .insert(dataMigrations)
    .values({ name: INBOX_NONACTIONABLE_PURGE_NAME })
    .onConflictDoNothing();

  logger.info({
    module: "db",
    action: "migrate.inbox_nonactionable_purge",
    msg: "notification inbox: non-actionable rows removed",
    deleted: removed.length,
  });
  return { skipped: false, deleted: removed.length };
}
