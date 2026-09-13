// Retention sweep for `cli_notification_inbox`.
//
// The inbox is a task list, not a queue: `/ack` marks a row read for one
// user instead of deleting it, so no request path removes rows and the
// table grows monotonically without this sweep. Read marks in
// `cli_notification_inbox_reads` disappear with their row through the FK
// cascade. The window comes from `notifications.inbox.retention_days`.
//
// Mirrors `chat-dedup-cleanup-runner.ts`: one summary audit row under
// SYSTEM_TENANT_ID after the sweep, errors caught + logged but never
// abort the rest of the reconciler tick. The DELETE filters by
// `created_at < now() - interval`, so multi-instance overlap is a no-op.

import { lt, sql } from "drizzle-orm";

import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../audit/index.ts";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { cliNotificationInbox } from "../db/schema/notifications.ts";
import { errorFields, logger } from "../logging/logger.ts";

export async function runNotificationInboxRetention(now: Date, db: Db): Promise<void> {
  const started = Date.now();
  const retentionDays = getConfig().notifications.inbox.retention_days;
  let deleted: number;
  try {
    // tenant-filter:exempt — cross-tenant retention sweep
    const result = await db
      .delete(cliNotificationInbox)
      .where(
        lt(
          cliNotificationInbox.created_at,
          sql`${now.toISOString()}::timestamptz - make_interval(days => ${retentionDays})`,
        ),
      )
      .returning({ id: cliNotificationInbox.id });
    deleted = result.length;
  } catch (err) {
    logger.warn({
      module: "scheduler",
      action: "notification_inbox_retention.sweep_failed",
      msg: "cli_notification_inbox retention sweep failed",
      ...errorFields(err),
    });
    return;
  }

  await auditAwait(
    {
      tenant_id: SYSTEM_TENANT_ID,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.NOTIFICATION_INBOX_PRUNED,
      resource_type: "cli_notification_inbox",
      resource_id: null,
      result: "success",
      metadata: {
        sweep: "cli_notification_inbox",
        retention_days: retentionDays,
        deleted,
        duration_ms: Date.now() - started,
      },
    },
    db,
  );
  logger.info({
    module: "scheduler",
    action: "notification_inbox_retention.completed",
    msg: "cli_notification_inbox retention sweep completed",
    retention_days: retentionDays,
    deleted,
    duration_ms: Date.now() - started,
  });
}
