import { and, eq, isNull, ne } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { roles, users } from "../db/schema/index.ts";
import { decideAdministratorChange } from "./core/administrators.ts";

export class LastAdminError extends Error {
  readonly code = "last_admin";
  constructor() {
    super(
      "This is the last administrator of the workspace; make someone else administrator first.",
    );
    this.name = "LastAdminError";
  }
}

export async function assertAdminRemains(
  tx: Executor,
  input: { tenant_id: string; user_id: string; nextEffectiveRole: string | null },
): Promise<void> {
  if (decideAdministratorChange(input.user_id, input.nextEffectiveRole, null).kind === "allowed")
    return;
  const rows = await tx
    .select({
      id: users.id,
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
  if (decideAdministratorChange(input.user_id, input.nextEffectiveRole, rows).kind === "rejected")
    throw new LastAdminError();
}
