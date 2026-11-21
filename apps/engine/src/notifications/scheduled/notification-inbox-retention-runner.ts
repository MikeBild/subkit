import { sql } from "drizzle-orm";
import { z } from "zod";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../../audit/index.ts";
import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { errorFields, logger } from "../../logging/index.ts";

export const NOTIFICATION_INBOX_RETENTION_BATCH_SIZE = 256;

const retainedIdsSchema = z
  .array(
    z
      .object({ id: z.union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)]) })
      .strict(),
  )
  .max(NOTIFICATION_INBOX_RETENTION_BATCH_SIZE);

export async function runNotificationInboxRetention(now: Date, db: Db): Promise<void> {
  const started = Date.now();
  const retentionDays = getConfig().notifications.inbox.retention_days;
  let deleted = 0;
  try {
    deleted = await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        WITH candidates AS MATERIALIZED (
          SELECT id,tenant_id FROM subkit.cli_notification_inbox
          WHERE created_at < ${now.toISOString()}::timestamptz - make_interval(days => ${retentionDays})
          ORDER BY created_at,id,tenant_id
          LIMIT ${NOTIFICATION_INBOX_RETENTION_BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM subkit.cli_notification_inbox AS inbox USING candidates
        WHERE inbox.id=candidates.id AND inbox.tenant_id=candidates.tenant_id
          AND inbox.created_at < ${now.toISOString()}::timestamptz - make_interval(days => ${retentionDays})
        RETURNING inbox.id
      `);
      const rows = retainedIdsSchema.parse(result.rows);
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
            request_source: "scheduler",
            sweep: "cli_notification_inbox",
            retention_days: retentionDays,
            deleted: rows.length,
            duration_ms: Date.now() - started,
          },
        },
        tx,
      );
      return rows.length;
    });
  } catch (err) {
    logger.warn({
      module: "scheduler",
      action: "notification_inbox_retention.sweep_failed",
      msg: "cli_notification_inbox retention sweep failed",
      ...errorFields(err),
    });
    return;
  }

  logger.info({
    module: "scheduler",
    action: "notification_inbox_retention.completed",
    msg: "cli_notification_inbox retention sweep completed",
    retention_days: retentionDays,
    deleted,
    duration_ms: Date.now() - started,
  });
}
