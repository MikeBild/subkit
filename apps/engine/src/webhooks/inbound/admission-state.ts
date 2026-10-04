import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { webhooksInbound } from "../../db/schema/index.ts";
import { invalidateTenantState } from "../../operator/index.ts";
import { emitResourceChange } from "../../pubsub/resource-changes.ts";
import { inspectInboundHookAutomation } from "../../scheduler/automation-status.ts";

export type InboundHoldReason = "execution_authority_required" | "execution_authority_unavailable";

export async function recordInboundAdmission(
  db: Db,
  context: { tenant_id: string; inbound_id: string; observed_at: Date },
  reason: InboundHoldReason | null,
): Promise<boolean> {
  const changed = await db.transaction(async (tx) => {
    if (reason) {
      const [hook] = await tx
        .select()
        .from(webhooksInbound)
        .where(
          and(
            eq(webhooksInbound.tenant_id, context.tenant_id),
            eq(webhooksInbound.id, context.inbound_id),
            eq(webhooksInbound.active, true),
          ),
        )
        .for("update");
      if (!hook || hook.admission_hold?.reason_code === reason) return false;
      if ((await inspectInboundHookAutomation(hook, tx)).ready) return false;
    }
    const hold = reason
      ? { reason_code: reason, observed_at: context.observed_at.toISOString() }
      : null;
    const rows = await tx
      .update(webhooksInbound)
      .set({ admission_hold: hold })
      .where(
        and(
          eq(webhooksInbound.tenant_id, context.tenant_id),
          eq(webhooksInbound.id, context.inbound_id),
          sql`(${webhooksInbound.admission_hold}->>'reason_code') IS DISTINCT FROM ${reason}::text`,
        ),
      )
      .returning({ id: webhooksInbound.id, workflow_id: webhooksInbound.workflow_id });
    if (rows.length === 0) return false;
    await emitResourceChange(tx, {
      tenant_id: context.tenant_id,
      type: "workflow.automation_changed",
      ids: { workflow_id: rows[0]?.workflow_id ?? null, hook_id: context.inbound_id },
    });
    return true;
  });
  if (changed) invalidateTenantState(context.tenant_id);
  return changed;
}
