// Engine-boot sweep for wait checkpoints that outlived their process.
//
// A `wait` step arms an in-process timer and writes a `workflow_waits` row;
// `wait_for_event` writes one and polls. On graceful shutdown the step clears
// its row. After a crash the row survives, and the thing that was going to
// resolve it does not.
//
// This used to re-enqueue `execution.run` for those executions and record
// `wait.completed { reason: "recovered" }`. Neither held:
//
//   - The execution is still `status='running'` after a crash, and
//     `markExecutionRunning` only transitions from `queued`. The re-enqueued
//     job therefore lost its CAS and returned "execution aborted before start"
//     every time. Nothing anywhere sets a running execution back to queued.
//   - Even had it started, `runExecution` begins at the first node of the
//     topological order and never consults existing `execution_steps` rows.
//     A "resume" would re-fire every side effect the run had already
//     performed. Silently doing nothing was the better of the two outcomes.
//
// So the audit trail asserted a recovery that never happened, which is worse
// than the missing feature: an operator reading `wait.completed` had no way to
// know the run was dead. The sweep now says what is true — the wait was
// abandoned — and leaves terminalization to `recoverCrashedExecutions`, which
// owns that transition and emits the terminal events with it.
//
// Resuming for real needs checkpointed step state, not a re-enqueue. Until
// that exists, a crashed wait is a lost run, and both the capability matrix
// and this audit action say so.

import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { workflowWaits } from "../db/schema/workflow_waits.ts";
import { logger } from "../logging/logger.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../queue/queues.ts";
import { now } from "../utils/clock.ts";

export interface ReapOrphanedWaitsResult {
  reaped: number;
}

export async function reapOrphanedWaits(db: Db, boss: PgBoss): Promise<ReapOrphanedWaitsResult> {
  void boss;
  // tenant-filter:exempt — the sweep covers every tenant; each row carries its
  // own tenant_id forward into the audit entry it produces.
  const orphans = await db.select().from(workflowWaits);
  if (orphans.length === 0) {
    await vacuumConsumedSignals(db);
    return { reaped: 0 };
  }

  let reaped = 0;
  for (const row of orphans) {
    // Drop the checkpoint first: it describes a timer that no longer exists,
    // and leaving it would make the next boot report the same orphan again.
    await db.delete(workflowWaits).where(eq(workflowWaits.id, row.id));
    await auditAwait(
      {
        tenant_id: row.tenant_id,
        actor_type: "system",
        action: AuditAction.WAIT_ABANDONED,
        resource_type: "execution",
        resource_id: row.execution_id,
        result: "success",
        reason: "engine_boot_reaper",
        metadata: {
          step_id: row.step_id,
          workflow_id: row.workflow_id,
          sleep_until_ts: row.sleep_until_ts.toISOString(),
          // True when the wait would have elapsed during the outage. Recorded
          // because it changes what an operator should do: an overdue wait was
          // ready to continue, a future one was still genuinely waiting.
          overdue: row.sleep_until_ts.getTime() <= now(),
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
      msg: "engine-boot abandoned orphan wait checkpoints; those executions do not resume",
      reaped,
    });
  }
  await vacuumConsumedSignals(db);
  return { reaped };
}

/** Stale consumed signals older than 7d — a garbage-collection nicety, not
 *  load-bearing for correctness. The received_at index makes the scan free. */
async function vacuumConsumedSignals(db: Db): Promise<void> {
  await db.execute(
    sql`DELETE FROM workflow_signals WHERE consumed_at IS NOT NULL AND consumed_at < now() - interval '7 days'`,
  );
}
