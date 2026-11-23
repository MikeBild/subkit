import { AuditAction, auditAwait } from "../audit/index.ts";
import type { Db } from "../db/index.ts";
import { planSnooze, type SnoozePlan } from "../operator/index.ts";
import {
  activeSnoozes,
  deleteSnooze,
  type SnoozeOwner,
  writeSnooze,
} from "./persistence/snoozes.ts";

export type { SnoozeOwner } from "./persistence/snoozes.ts";
export { activeSnoozes };

export async function snoozeAttention(
  db: Db,
  owner: SnoozeOwner,
  input: { attention_key: string; until: Date },
  at: Date,
): Promise<SnoozePlan> {
  const plan = planSnooze(input.until, at);
  if (!plan.ok) return plan;
  await writeSnooze(
    db,
    owner,
    { attention_key: input.attention_key, snoozed_until: plan.until },
    at,
  );
  await auditAwait({
    tenant_id: owner.tenant_id,
    actor_type: "user",
    actor_id: owner.user_id,
    action: AuditAction.ATTENTION_SNOOZED,
    resource_type: "attention",
    resource_id: null,
    result: "success",
    metadata: { attention_key: input.attention_key, until: plan.until.toISOString() },
  });
  return plan;
}

export async function unsnoozeAttention(
  db: Db,
  owner: SnoozeOwner,
  attention_key: string,
): Promise<boolean> {
  const removed = await deleteSnooze(db, owner, attention_key);
  if (removed)
    await auditAwait({
      tenant_id: owner.tenant_id,
      actor_type: "user",
      actor_id: owner.user_id,
      action: AuditAction.ATTENTION_UNSNOOZED,
      resource_type: "attention",
      resource_id: null,
      result: "success",
      metadata: { attention_key },
    });
  return removed;
}
