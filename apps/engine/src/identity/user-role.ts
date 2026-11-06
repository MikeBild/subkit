import { and, eq } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { users } from "../db/schema/index.ts";
import { assertAdminRemains } from "./last-admin.ts";

interface AssignUserRoleInput {
  tenant_id: string;
  user_id: string;
  role_id: string;
  role_name: string;
  actor: Pick<ResolvedPrincipal, "kind" | "id">;
}

export async function assignUserRole(db: Db, input: AssignUserRoleInput): Promise<boolean> {
  const rows = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenant_id, input.tenant_id), eq(users.id, input.user_id)))
      .limit(1);
    if (current) {
      await assertAdminRemains(tx, {
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        nextEffectiveRole: input.role_name,
      });
    }
    return tx
      .update(users)
      .set({ role_id: input.role_id })
      .where(and(eq(users.tenant_id, input.tenant_id), eq(users.id, input.user_id)))
      .returning({ id: users.id });
  });
  if (rows.length === 0) return false;
  await auditAwait(
    {
      tenant_id: input.tenant_id,
      actor_type: input.actor.kind,
      actor_id: input.actor.id,
      action: AuditAction.RBAC_USER_ROLE_ASSIGNED,
      resource_type: "user",
      resource_id: input.user_id,
      result: "success",
      metadata: { role_id: input.role_id },
    },
    db,
  );
  return true;
}
