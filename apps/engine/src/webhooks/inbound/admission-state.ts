import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { webhooksInbound } from "../../db/schema/index.ts";
import { invalidateTenantState } from "../../operator/index.ts";
import { inspectInboundHookAutomation } from "../../scheduler/automation-status.ts";

export type InboundHoldReason = "execution_authority_required" | "execution_authority_unavailable";

/**
 * Keep the last delivery the execution-authority gate refused on the hook, so
 * a workflow no delivery can start reads as blocked — the counterpart of
 * `recordScheduleAdmission`. Each refused delivery is already audited on its
 * own; this is the standing state, and it moves only on a change: a hold
 * with the same reason is not rewritten, an admitted delivery clears it.
 */
export async function recordInboundAdmission(
  db: Db,
  context: { tenant_id: string; inbound_id: string; observed_at: Date },
  reason: InboundHoldReason | null,
): Promise<void> {
  const changed = await db.transaction(async (tx) => {
    // Serialize with human grants (`resolveGrantedInboundHold` locks the same
    // row). A refusal observed before a grant must not re-hold the hook after
    // that grant commits.
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
      if (!hook || (await inspectInboundHookAutomation(hook, tx)).ready) return false;
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
      .returning({ id: webhooksInbound.id });
    return rows.length > 0;
  });
  if (changed) invalidateTenantState(context.tenant_id);
}
