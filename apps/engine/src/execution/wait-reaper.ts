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

async function vacuumConsumedSignals(db: Db): Promise<void> {
  await db.execute(
    sql`DELETE FROM workflow_signals WHERE consumed_at IS NOT NULL AND consumed_at < now() - interval '7 days'`,
  );
}
