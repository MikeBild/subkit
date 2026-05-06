// Engine-boot reaper for orphaned wait checkpoints (#48).
//
// On graceful shutdown the wait step deletes its `workflow_waits` row
// before resolving. After a crash the row survives. On the next boot,
// `reapOrphanedWaits` walks the table and decides per row:
//
//   - sleep_until_ts < now()  →  the timer would have fired during the
//                                outage. Re-enqueue the execution
//                                immediately (sendAfter omitted) and
//                                drop the checkpoint row.
//   - sleep_until_ts ≥ now()  →  re-enqueue with `sendAfter:
//                                sleep_until_ts` so pg-boss fires the
//                                resume at the right wall-clock instant
//                                and drop the checkpoint row.
//
// Each resumed wait emits `WAIT_COMPLETED { reason: "recovered" }` so an
// operator grepping the audit log can see exactly which checkpoints
// survived a crash.
//
// `wait_for_event` rows live in the same table — their poller is purely
// DB-driven (consumeMatchingSignal), so a fresh `execution.run` resume
// re-enters the step and continues polling. No special-case needed.

import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { workflowWaits } from "../db/schema/workflow_waits.ts";
import { logger } from "../logging/logger.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../queue/queues.ts";

export interface ReapOrphanedWaitsResult {
  reaped: number;
}

export async function reapOrphanedWaits(db: Db, boss: PgBoss): Promise<ReapOrphanedWaitsResult> {
  const orphans = await db.select().from(workflowWaits);
  if (orphans.length === 0) return { reaped: 0 };

  const now = Date.now();
  let reaped = 0;
  for (const row of orphans) {
    const sleepUntilMs = row.sleep_until_ts.getTime();
    const overdue = sleepUntilMs <= now;
    const job: ExecutionRunJob = {
      tenant_id: row.tenant_id,
      workflow_id: row.workflow_id,
      execution_id: row.execution_id,
      request_source: "wait_reaper",
    };
    try {
      await boss.send(
        EXECUTION_RUN_QUEUE,
        job as unknown as Record<string, unknown>,
        overdue ? {} : { startAfter: row.sleep_until_ts },
      );
    } catch (err) {
      logger.error({
        module: "execution",
        action: "wait_reaper.enqueue_failed",
        msg: "failed to re-enqueue orphan wait; row left in place for next boot",
        execution_id: row.execution_id,
        step_id: row.step_id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    await db.delete(workflowWaits).where(eq(workflowWaits.id, row.id));
    await auditAwait(
      {
        tenant_id: row.tenant_id,
        actor_type: "system",
        action: AuditAction.WAIT_COMPLETED,
        resource_type: "execution",
        resource_id: row.execution_id,
        result: "success",
        reason: "engine_boot_reaper",
        metadata: {
          step_id: row.step_id,
          workflow_id: row.workflow_id,
          reason: "recovered",
          overdue,
          sleep_until_ts: row.sleep_until_ts.toISOString(),
        },
      },
      db,
    );
    reaped += 1;
  }
  if (reaped > 0) {
    logger.info({
      module: "execution",
      action: "wait_reaper.complete",
      msg: "engine-boot reaped orphan waits",
      reaped,
    });
  }
  // Vacuum stale `consumed_at` signals older than 7d — purely a
  // garbage-collection nicety, not load-bearing for correctness. The
  // `workflow_signals_received_at_idx` makes this scan free.
  await db.execute(
    sql`DELETE FROM workflow_signals WHERE consumed_at IS NOT NULL AND consumed_at < now() - interval '7 days'`,
  );
  return { reaped };
}
