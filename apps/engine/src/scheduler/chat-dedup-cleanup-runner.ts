import { sql } from "drizzle-orm";
import { z } from "zod";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../audit/index.ts";
import type { Executor } from "../db/client.ts";
import { errorFields, logger } from "../logging/logger.ts";

export const CHAT_DEDUP_CLEANUP_BATCH_SIZE = 256;
const REPLAY_GRACE = sql`interval '24 hours'`;
const deletedCountSchema = z.tuple([
  z.object({ deleted: z.number().int().min(0).max(CHAT_DEDUP_CLEANUP_BATCH_SIZE) }).strict(),
]);

export async function runChatDedupCleanup(now: Date, db: Executor): Promise<void> {
  const started = Date.now();
  let deleted = 0;
  try {
    deleted = await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        WITH candidates AS MATERIALIZED (
          SELECT tenant_id,workspace_id,platform_event_id FROM subkit.chat_events_seen
          WHERE seen_at < ${now.toISOString()}::timestamptz - ${REPLAY_GRACE}
          ORDER BY seen_at,tenant_id,workspace_id,platform_event_id
          LIMIT ${CHAT_DEDUP_CLEANUP_BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        ), removed AS (
          DELETE FROM subkit.chat_events_seen AS seen USING candidates
          WHERE seen.tenant_id=candidates.tenant_id AND seen.workspace_id=candidates.workspace_id
            AND seen.platform_event_id=candidates.platform_event_id
            AND seen.seen_at < ${now.toISOString()}::timestamptz - ${REPLAY_GRACE}
          RETURNING 1
        ) SELECT count(*)::int AS deleted FROM removed
      `);
      const count = deletedCountSchema.parse(result.rows)[0].deleted;
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
            request_source: "scheduler",
            sweep: "chat_events_seen",
            deleted: count,
            duration_ms: Date.now() - started,
          },
        },
        tx,
      );
      return count;
    });
  } catch (err) {
    logger.warn({
      module: "scheduler",
      action: "chat_dedup_cleanup.sweep_failed",
      msg: "chat_events_seen retention transaction failed",
      ...errorFields(err),
    });
    return;
  }
  logger.info({
    module: "scheduler",
    action: "chat_dedup_cleanup.completed",
    msg: "chat_events_seen retention sweep completed",
    deleted,
    duration_ms: Date.now() - started,
  });
}
