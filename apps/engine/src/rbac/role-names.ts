import { and, eq, isNull, or } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { roles } from "../db/schema/index.ts";

export async function roleNameById(
  db: Executor,
  tenant_id: string,
  role_id: string,
): Promise<string | null> {
  const [role] = await db
    .select({ name: roles.name })
    .from(roles)
    .where(and(eq(roles.id, role_id), or(isNull(roles.tenant_id), eq(roles.tenant_id, tenant_id))))
    .limit(1);
  return role?.name ?? null;
}

export async function roleNamesById(db: Executor, tenant_id: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(or(isNull(roles.tenant_id), eq(roles.tenant_id, tenant_id)));
  return new Map(rows.map((role) => [role.id, role.name]));
}
