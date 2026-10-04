import { and, eq, isNull, ne } from "drizzle-orm";
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

export async function assertAdminRemains(
  tx: Executor,
  input: { tenant_id: string; user_id: string; nextEffectiveRole: string | null },
): Promise<void> {
  if (input.nextEffectiveRole === "admin") return;
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
  const admins = rows.filter((row) => row.assigned === "admin");
  if (!admins.some((row) => row.id === input.user_id)) return;
  if (admins.length <= 1) throw new LastAdminError();
}
