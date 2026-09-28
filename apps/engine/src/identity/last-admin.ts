// An installation always keeps one administrator.
//
// Admin-only routes check the ROLE NAME (`policy.adminOnly` → effective role
// "admin", auth/user-role.ts). Moving the last admin to another role — even a
// custom role that holds every permission — or deactivating them leaves a
// tenant nobody can manage people or roles in any more, and nothing in the
// product can undo it. Every path that changes who is admin runs through this
// check inside its own transaction.

import { and, eq, isNull, ne } from "drizzle-orm";
import { resolveEffectiveUserRole } from "../auth/user-role.ts";
import type { Executor } from "../db/client.ts";
import { roles, users } from "../db/schema/index.ts";

export class LastAdminError extends Error {
  readonly code = "last_admin";
  constructor() {
    super(
      "This is the last administrator of the workspace; make someone else administrator first.",
    );
    this.name = "LastAdminError";
  }
}

/**
 * Throws `LastAdminError` when `user_id` is an administrator who would stop
 * being one (`nextEffectiveRole` is another role, or `null` for deactivation)
 * and no other administrator remains. The tenant's user rows are locked for
 * the rest of the transaction, so two concurrent demotions cannot both pass.
 */
export async function assertAdminRemains(
  tx: Executor,
  input: { tenant_id: string; user_id: string; nextEffectiveRole: string | null },
): Promise<void> {
  if (input.nextEffectiveRole === "admin") return;
  const rows = await tx
    .select({
      id: users.id,
      role: users.role,
      status: users.status,
      assigned: roles.name,
    })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(
      and(
        eq(users.tenant_id, input.tenant_id),
        isNull(users.deleted_at),
        ne(users.status, "disabled"),
      ),
    )
    .for("update", { of: users });
  const admins = rows.filter((row) => resolveEffectiveUserRole(row.role, row.assigned) === "admin");
  if (!admins.some((row) => row.id === input.user_id)) return;
  if (admins.length <= 1) throw new LastAdminError();
}
