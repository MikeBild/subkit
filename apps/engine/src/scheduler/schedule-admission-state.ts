import { and, eq, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { workflowsSchedules } from "../db/schema/index.ts";
import { invalidateOperationalOverview } from "../operator/index.ts";
import { inspectScheduleAutomation } from "./automation-status.ts";

/** Preserve the last refused admission across restarts, without creating a
 * decision on every scheduler tick. Only the owner of the cadence claim may
 * change it; a stale worker cannot overwrite a later successful admission. */
export async function recordScheduleAdmission(
  db: Db,
  context: { tenant_id: string; schedule_id: string; claimed_at: Date },
  reason: "execution_authority_required" | "execution_authority_unavailable" | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialize with human grants. A refusal observed before a grant must not
    // resurrect its cleared decision after that grant commits.
    if (reason) {
      const [schedule] = await tx
        .select()
        .from(workflowsSchedules)
        .where(
          and(
            eq(workflowsSchedules.tenant_id, context.tenant_id),
            eq(workflowsSchedules.id, context.schedule_id),
            eq(workflowsSchedules.paused, false),
            sql`date_trunc('milliseconds', ${workflowsSchedules.last_enqueued_at}) = ${context.claimed_at}`,
          ),
        )
        .for("update");
      if (!schedule || (await inspectScheduleAutomation(schedule, tx)).ready) return;
    }
    const hold = reason
      ? { reason_code: reason, observed_at: context.claimed_at.toISOString() }
      : null;
    const changed = await tx
      .update(workflowsSchedules)
      .set({ admission_hold: hold })
      .where(
        and(
          eq(workflowsSchedules.tenant_id, context.tenant_id),
          eq(workflowsSchedules.id, context.schedule_id),
          eq(workflowsSchedules.paused, false),
          sql`date_trunc('milliseconds', ${workflowsSchedules.last_enqueued_at}) = ${context.claimed_at}`,
          sql`(${workflowsSchedules.admission_hold}->>'reason_code') IS DISTINCT FROM ${reason}::text`,
        ),
      )
      .returning({ id: workflowsSchedules.id });
    if (!changed.length) return;
    await auditAwait(
      {
        tenant_id: context.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.SCHEDULE_ADMISSION_CHANGED,
        resource_type: "workflow_schedule",
        resource_id: context.schedule_id,
        result: "success",
        metadata: {
          request_source: "scheduler",
          reason_code: reason,
          state: reason ? "held" : "admitted",
        },
      },
      tx,
    );
  });
  invalidateOperationalOverview(context.tenant_id);
}
