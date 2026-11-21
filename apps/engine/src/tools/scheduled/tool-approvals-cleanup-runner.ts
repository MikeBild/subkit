import { sql } from "drizzle-orm";
import { z } from "zod";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../../audit/index.ts";
import type { Executor } from "../../db/client.ts";
import { errorFields, logger } from "../../logging/index.ts";

const TOOL_APPROVAL_CLEANUP_BATCH_SIZE = 256;
const APPROVAL_RETENTION = sql`interval '1 day'`;
const deletedCountSchema = z.tuple([
  z.object({ deleted: z.number().int().min(0).max(TOOL_APPROVAL_CLEANUP_BATCH_SIZE) }).strict(),
]);

export async function runToolApprovalsCleanup(started: Date, db: Executor): Promise<void> {
  const tickId = started.toISOString();
  let expired_deleted = 0;
  let consumed_deleted = 0;
  try {
    const counts = await db.transaction(async (tx) => {
      // tenant-filter:exempt — bounded global retention locks keys and rechecks each owner and expiry.
      const expired = await tx.execute(sql`
        WITH candidates AS MATERIALIZED (
          SELECT id,tenant_id FROM subkit.tool_approvals
          WHERE consumed_at IS NULL AND expires_at < now() - ${APPROVAL_RETENTION}
          ORDER BY expires_at,id,tenant_id
          LIMIT ${TOOL_APPROVAL_CLEANUP_BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        ), removed AS (
          DELETE FROM subkit.tool_approvals AS approvals USING candidates
          WHERE approvals.id=candidates.id AND approvals.tenant_id=candidates.tenant_id
            AND approvals.consumed_at IS NULL AND approvals.expires_at < now() - ${APPROVAL_RETENTION}
          RETURNING 1
        ) SELECT count(*)::int AS deleted FROM removed
      `);
      const expiredCount = deletedCountSchema.parse(expired.rows)[0].deleted;
      // tenant-filter:exempt — consumed retention uses bounded keys and its original consumption grace.
      const consumed = await tx.execute(sql`
        WITH candidates AS MATERIALIZED (
          SELECT id,tenant_id FROM subkit.tool_approvals
          WHERE consumed_at IS NOT NULL AND consumed_at < now() - ${APPROVAL_RETENTION}
          ORDER BY consumed_at,id,tenant_id
          LIMIT ${TOOL_APPROVAL_CLEANUP_BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        ), removed AS (
          DELETE FROM subkit.tool_approvals AS approvals USING candidates
          WHERE approvals.id=candidates.id AND approvals.tenant_id=candidates.tenant_id
            AND approvals.consumed_at IS NOT NULL AND approvals.consumed_at < now() - ${APPROVAL_RETENTION}
          RETURNING 1
        ) SELECT count(*)::int AS deleted FROM removed
      `);
      const consumedCount = deletedCountSchema.parse(consumed.rows)[0].deleted;
      await auditAwait(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.APPROVAL_EXPIRED_PRUNED,
          resource_type: "tool_approval",
          resource_id: null,
          result: "success",
          metadata: {
            request_source: "scheduler",
            sweep: "tool_approvals",
            expired_deleted: expiredCount,
            consumed_deleted: consumedCount,
          },
        },
        tx,
      );
      return { expired: expiredCount, consumed: consumedCount };
    });
    expired_deleted = counts.expired;
    consumed_deleted = counts.consumed;
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "tool_approvals_cleanup.sweep_failed",
      msg: "tool approval retention transaction failed",
      tick_id: tickId,
      ...errorFields(err),
    });
    return;
  }
  logger.info({
    module: "scheduler",
    action: "tool_approvals_cleanup.fired",
    msg: "tool_approvals retention sweep completed",
    tick_id: tickId,
    expired_deleted,
    consumed_deleted,
    deleted: expired_deleted + consumed_deleted,
    duration_ms: Date.now() - started.getTime(),
  });
}
