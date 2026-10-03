import { and, eq, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { workflowsSchedules } from "../db/schema/index.ts";
import { invalidateTenantState } from "../operator/index.ts";
import { emitResourceChange } from "../pubsub/resource-changes.ts";
import { inspectScheduleAutomation } from "./automation-status.ts";

/** Preserve the last refused admission across restarts, without creating a
 * decision on every scheduler tick. Only the owner of the cadence claim may
 * change it; a stale worker cannot overwrite a later successful admission.
 * Returns whether the standing state changed — the edge a caller reacts to
 * once, not on every refused tick. */
export async function recordScheduleAdmission(
  db: Db,
  context: { tenant_id: string; schedule_id: string; claimed_at: Date },
  reason: "execution_authority_required" | "execution_authority_unavailable" | null,
): Promise<boolean> {
  const changedState = await db.transaction(async (tx) => {
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
      if (!schedule || (await inspectScheduleAutomation(schedule, tx)).ready) return false;
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
      .returning({ id: workflowsSchedules.id, workflow_id: workflowsSchedules.workflow_id });
    if (!changed.length) return false;
    await auditAwait(
      {
        tenant_id: context.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.SCHEDULE_ADMISSION_CHANGED,
        resource_type: "workflow_schedule",
        resource_id: context.schedule_id,
        // The edge, not the tick: one row per state change. A hold IS a
        // refusal and says so in the column every other refusal uses, so
        // "show me what was refused" finds it without knowing this action
        // exists. Clearing the hold is the admission going through.
        result: reason ? "denied" : "success",
        reason: reason ?? null,
        metadata: {
          request_source: "scheduler",
          // Kept alongside `reason` for readers that already parse it.
          reason_code: reason,
          state: reason ? "held" : "admitted",
        },
      },
      tx,
    );
    await emitResourceChange(tx, {
      tenant_id: context.tenant_id,
      type: "workflow.automation_changed",
      ids: { workflow_id: changed[0]?.workflow_id ?? null, schedule_id: context.schedule_id },
    });
    return true;
  });
  invalidateTenantState(context.tenant_id);
  return changedState;
}
