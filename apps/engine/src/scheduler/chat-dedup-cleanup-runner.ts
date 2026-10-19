import { sql } from "drizzle-orm";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../audit/index.ts";
import type { Db } from "../db/client.ts";
import { chatEventsSeen } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";

const REPLAY_GRACE = sql`interval '24 hours'`;
export const CHAT_DEDUP_CLEANUP_BATCH_SIZE = 500;

export async function runChatDedupCleanup(now: Date, db: Db): Promise<void> {
  const started = Date.now();
  let deleted = 0;
  try {
    const result = await db.execute(sql`
      WITH batch AS (
        SELECT tenant_id, workspace_id, platform_event_id FROM ${chatEventsSeen}
        WHERE seen_at < ${now.toISOString()}::timestamptz - ${REPLAY_GRACE}
        ORDER BY seen_at, workspace_id, platform_event_id
        LIMIT ${CHAT_DEDUP_CLEANUP_BATCH_SIZE} FOR UPDATE SKIP LOCKED
      )
      DELETE FROM ${chatEventsSeen} AS seen USING batch
      WHERE seen.tenant_id = batch.tenant_id AND seen.workspace_id = batch.workspace_id
        AND seen.platform_event_id = batch.platform_event_id
      RETURNING seen.platform_event_id
    `);
    deleted = result.rowCount ?? 0;
  } catch (err) {
    logger.warn({
      module: "scheduler",
      action: "chat_dedup_cleanup.sweep_failed",
      msg: "chat_events_seen retention sweep failed",
      ...errorFields(err),
    });
    return;
  }

  await auditAwait(
    {
      tenant_id: SYSTEM_TENANT_ID,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.CHAT_DEDUP_PRUNED,
      resource_type: "chat_events_seen",
      resource_id: null,
      result: "success",
      metadata: {
        sweep: "chat_events_seen",
        deleted,
        duration_ms: Date.now() - started,
      },
    },
    db,
  );
  logger.info({
    module: "scheduler",
    action: "chat_dedup_cleanup.completed",
    msg: "chat_events_seen retention sweep completed",
    deleted,
    duration_ms: Date.now() - started,
  });
}
