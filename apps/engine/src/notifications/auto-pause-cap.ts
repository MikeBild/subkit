import { and, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { withTenantScope } from "../db/index.ts";
import { cockpitPushSubscriptions } from "../db/schema/cockpit-push.ts";

export const AUTO_PAUSE_NOTICE_WINDOW_MS = 60 * 60 * 1000;
export const AUTO_PAUSE_REASON = "schedule_auto_paused";

export function isAutoPause(item: { readonly reason: string }): boolean {
  return item.reason === AUTO_PAUSE_REASON;
}

export function pausedSummary(
  fresh: readonly { readonly reason: string }[],
): { schedules_paused: number } | undefined {
  const paused = fresh.filter(isAutoPause).length;
  return paused >= 2 ? { schedules_paused: paused } : undefined;
}

export async function autoPauseNoticeCapped(
  db: Db,
  tenantId: string,
  subscriptionIds: readonly string[],
  at: Date,
): Promise<boolean> {
  if (subscriptionIds.length === 0) return false;
  const since = new Date(at.getTime() - AUTO_PAUSE_NOTICE_WINDOW_MS);
  const rows = await withTenantScope(db, tenantId, (tx) =>
    tx
      .select({ id: cockpitPushSubscriptions.id })
      .from(cockpitPushSubscriptions)
      .where(
        and(
          eq(cockpitPushSubscriptions.tenant_id, tenantId),
          inArray(cockpitPushSubscriptions.id, [...subscriptionIds]),
          gt(cockpitPushSubscriptions.auto_pause_notified_at, since),
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}

export async function markAutoPauseNotified(
  db: Db,
  tenantId: string,
  subscriptionIds: readonly string[],
  at: Date,
): Promise<void> {
  if (subscriptionIds.length === 0) return;
  await withTenantScope(db, tenantId, (tx) =>
    tx
      .update(cockpitPushSubscriptions)
      .set({ auto_pause_notified_at: at })
      .where(
        and(
          eq(cockpitPushSubscriptions.tenant_id, tenantId),
          inArray(cockpitPushSubscriptions.id, [...subscriptionIds]),
        ),
      ),
  );
}
