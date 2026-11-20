import { and, eq, isNull, ne } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { roles, userSetupPreferences, users } from "../db/schema/index.ts";
import { approverMayActOn } from "../operator/attention-waiting-on.ts";
import type { AttentionItem } from "../operator/core/attention.ts";
import { needsApproval } from "../operator/core/attention.ts";

export const MAX_REQUESTERS_PER_APPROVER = 20;

export async function pushPrincipal(
  db: Db,
  tenantId: string,
  user_id: string,
  installation_id: string | null = null,
): Promise<ResolvedPrincipal | null> {
  const [owner] = await db
    .select({ role_name: roles.name })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(and(eq(users.tenant_id, tenantId), eq(users.id, user_id)))
    .limit(1);
  if (!owner) return null;
  return {
    provider: "cockpit_push",
    kind: "user",
    id: user_id,
    tenant_id: tenantId,
    roles: owner.role_name ? [owner.role_name] : [],
    ...(installation_id ? { installation_id } : {}),
  };
}

export async function requestersOf(
  db: Db,
  tenantId: string,
  approver_id: string,
): Promise<string[]> {
  const rows = await db
    .select({ user_id: userSetupPreferences.user_id })
    .from(userSetupPreferences)
    .innerJoin(
      users,
      and(
        eq(users.id, userSetupPreferences.user_id),
        eq(users.tenant_id, userSetupPreferences.tenant_id),
      ),
    )
    .where(
      and(
        eq(userSetupPreferences.tenant_id, tenantId),
        eq(userSetupPreferences.approver_kind, "teammate"),
        eq(userSetupPreferences.approver_user_id, approver_id),
        ne(userSetupPreferences.user_id, approver_id),
        eq(users.status, "active"),
        isNull(users.deleted_at),
      ),
    )
    .orderBy(userSetupPreferences.user_id)
    .limit(MAX_REQUESTERS_PER_APPROVER);
  return rows.map((row) => row.user_id);
}

export async function itemsKeptByRequester(
  db: Db,
  tenantId: string,
  approver: ResolvedPrincipal | null,
  items: readonly AttentionItem[],
): Promise<AttentionItem[]> {
  if (!approver) return [...items];
  const allowed = new Map<string, boolean>();
  const kept: AttentionItem[] = [];
  for (const item of items) {
    if (!needsApproval(item) || !(await approverMayActOn(db, tenantId, approver, item, allowed)))
      kept.push(item);
  }
  return kept;
}

export async function delegatedApprovalItems(
  db: Db,
  tenantId: string,
  approver: ResolvedPrincipal,
  attentionOf: (principal: ResolvedPrincipal) => Promise<readonly AttentionItem[]>,
): Promise<AttentionItem[]> {
  const out = new Map<string, AttentionItem>();
  const allowed = new Map<string, boolean>();
  for (const requester_id of await requestersOf(db, tenantId, approver.id)) {
    const requester = await pushPrincipal(db, tenantId, requester_id);
    if (!requester) continue;
    for (const item of await attentionOf(requester)) {
      if (!needsApproval(item) || out.has(item.id)) continue;
      if (await approverMayActOn(db, tenantId, approver, item, allowed)) out.set(item.id, item);
    }
  }
  return [...out.values()];
}
