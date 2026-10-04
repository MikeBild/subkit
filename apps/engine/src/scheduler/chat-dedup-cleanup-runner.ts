import { lt, sql } from "drizzle-orm";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../audit/index.ts";
import type { Db } from "../db/client.ts";
import { chatEventsSeen } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";

const REPLAY_GRACE = sql`interval '24 hours'`;

export async function runChatDedupCleanup(now: Date, db: Db): Promise<void> {
  const started = Date.now();
  let deleted = 0;
  try {
    const result = await db
      .delete(chatEventsSeen)
      .where(lt(chatEventsSeen.seen_at, sql`${now.toISOString()}::timestamptz - ${REPLAY_GRACE}`))
      .returning({ platform_event_id: chatEventsSeen.platform_event_id });
    deleted = result.length;
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
