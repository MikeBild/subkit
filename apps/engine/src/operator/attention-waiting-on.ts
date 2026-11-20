import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { roles, users } from "../db/schema/index.ts";
import type { ApproverPerson } from "../identity/setup-preferences.ts";
import { principalHolds } from "../rbac/evaluator.ts";
import { type AttentionItem, needsApproval } from "./core/attention.ts";

export async function approverMayActOn(
  db: Db,
  tenantId: string,
  approver: ResolvedPrincipal,
  item: AttentionItem,
  allowed: Map<string, boolean>,
): Promise<boolean> {
  const permission = (item.actions.find((action) => action.primary) ?? item.actions[0])?.permission;
  if (!permission) return false;
  let may = allowed.get(permission);
  if (may === undefined) {
    may = approver.tenant_id === tenantId && (await principalHolds(db, approver, permission));
    allowed.set(permission, may);
  }
  return may;
}

async function approverPrincipal(
  db: Db,
  tenantId: string,
  user_id: string,
): Promise<ResolvedPrincipal | null> {
  const [person] = await db
    .select({ role_name: roles.name })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(and(eq(users.tenant_id, tenantId), eq(users.id, user_id)))
    .limit(1);
  if (!person) return null;
  return {
    provider: "attention_approver",
    kind: "user",
    id: user_id,
    tenant_id: tenantId,
    roles: person.role_name ? [person.role_name] : [],
  };
}

export async function withWaitingOn(
  db: Db,
  tenantId: string,
  approver: ApproverPerson | null,
  items: readonly AttentionItem[],
): Promise<AttentionItem[]> {
  if (!approver || !items.some(needsApproval)) return [...items];
  const principal = await approverPrincipal(db, tenantId, approver.user_id);
  if (!principal) return [...items];
  const allowed = new Map<string, boolean>();
  const out: AttentionItem[] = [];
  for (const item of items) {
    const waits =
      needsApproval(item) && (await approverMayActOn(db, tenantId, principal, item, allowed));
    out.push(
      waits ? { ...item, waiting_on: { user_id: approver.user_id, name: approver.name } } : item,
    );
  }
  return out;
}
