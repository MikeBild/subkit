import { and, eq, isNull, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { Executor } from "../db/client.ts";
import { userSetupPreferences, users } from "../db/schema/index.ts";
import {
  type PauseView,
  pauseView,
  type StoredPause,
} from "../notifications/notification-pause.ts";

export interface PauseOwner {
  readonly tenant_id: string;
  readonly user_id: string;
}

async function storedPause(db: Executor, owner: PauseOwner): Promise<StoredPause> {
  const [row] = await db
    .select({
      paused_at: userSetupPreferences.notifications_paused_at,
      paused_until: userSetupPreferences.notifications_paused_until,
    })
    .from(userSetupPreferences)
    .where(
      and(
        eq(userSetupPreferences.tenant_id, owner.tenant_id),
        eq(userSetupPreferences.user_id, owner.user_id),
      ),
    )
    .limit(1);
  return { paused_at: row?.paused_at ?? null, paused_until: row?.paused_until ?? null };
}

export async function readNotificationPause(
  db: Executor,
  owner: PauseOwner,
  at: Date,
): Promise<PauseView> {
  return pauseView(await storedPause(db, owner), at);
}

function audited(view: PauseView) {
  return {
    paused: view.paused,
    mode: view.mode,
    until: view.until ? view.until.toISOString() : null,
  };
}

export async function writeNotificationPause(
  db: Executor,
  owner: PauseOwner,
  next: StoredPause,
  at: Date,
  source: string,
): Promise<PauseView | null> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.tenant_id, owner.tenant_id),
          eq(users.id, owner.user_id),
          isNull(users.deleted_at),
        ),
      )
      .for("update")
      .limit(1);
    if (!user) return null;
    const before = pauseView(await storedPause(tx, owner), at);
    const values = {
      notifications_paused_at: next.paused_at,
      notifications_paused_until: next.paused_until,
    };
    await tx
      .insert(userSetupPreferences)
      .values({ tenant_id: owner.tenant_id, user_id: owner.user_id, ...values })
      .onConflictDoUpdate({
        target: [userSetupPreferences.tenant_id, userSetupPreferences.user_id],
        set: { ...values, updated_at: sql`now()` },
      });
    const after = pauseView(next, at);
    if (before.paused || after.paused) {
      await auditAwait(
        {
          tenant_id: owner.tenant_id,
          actor_type: "user",
          actor_id: owner.user_id,
          action: after.paused
            ? AuditAction.USER_NOTIFICATIONS_PAUSED
            : AuditAction.USER_NOTIFICATIONS_RESUMED,
          resource_type: "user",
          resource_id: owner.user_id,
          result: "success",
          before: audited(before),
          after: audited(after),
          metadata: { source },
        },
        tx,
      );
    }
    return after;
  });
}
