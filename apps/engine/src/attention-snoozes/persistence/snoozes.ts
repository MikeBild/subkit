import { and, eq, gt, lte } from "drizzle-orm";
import { attentionSnoozes, type Executor } from "../../db/index.ts";
import type { AttentionSnooze } from "../../operator/index.ts";

export interface SnoozeOwner {
  readonly tenant_id: string;
  readonly user_id: string;
}

export async function activeSnoozes(
  db: Executor,
  owner: SnoozeOwner,
  at: Date,
): Promise<AttentionSnooze[]> {
  return db
    .select({
      attention_key: attentionSnoozes.attention_key,
      snoozed_until: attentionSnoozes.snoozed_until,
    })
    .from(attentionSnoozes)
    .where(
      and(
        eq(attentionSnoozes.tenant_id, owner.tenant_id),
        eq(attentionSnoozes.user_id, owner.user_id),
        gt(attentionSnoozes.snoozed_until, at),
      ),
    )
    .limit(500);
}

export async function writeSnooze(
  db: Executor,
  owner: SnoozeOwner,
  snooze: AttentionSnooze,
  at: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(attentionSnoozes)
      .where(
        and(
          eq(attentionSnoozes.tenant_id, owner.tenant_id),
          eq(attentionSnoozes.user_id, owner.user_id),
          lte(attentionSnoozes.snoozed_until, at),
        ),
      );
    await tx
      .insert(attentionSnoozes)
      .values({
        tenant_id: owner.tenant_id,
        user_id: owner.user_id,
        attention_key: snooze.attention_key,
        snoozed_until: snooze.snoozed_until,
      })
      .onConflictDoUpdate({
        target: [
          attentionSnoozes.tenant_id,
          attentionSnoozes.user_id,
          attentionSnoozes.attention_key,
        ],
        set: { snoozed_until: snooze.snoozed_until, created_at: at },
      });
  });
}

export async function deleteSnooze(
  db: Executor,
  owner: SnoozeOwner,
  attention_key: string,
): Promise<boolean> {
  const removed = await db
    .delete(attentionSnoozes)
    .where(
      and(
        eq(attentionSnoozes.tenant_id, owner.tenant_id),
        eq(attentionSnoozes.user_id, owner.user_id),
        eq(attentionSnoozes.attention_key, attention_key),
      ),
    )
    .returning({ attention_key: attentionSnoozes.attention_key });
  return removed.length > 0;
}
