import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { roles as rolesTable, systemAccounts, users as usersTable } from "../db/schema/index.ts";

export interface QueryPrincipal {
  provider: string;
  kind: "user" | "system_account";
  id: string;
  tenant_id: string;
  roles: string[];
}

export async function buildQueryPrincipal(
  db: Db,
  tenant_id: string,
  id: string,
): Promise<QueryPrincipal | null> {
  const uRows = await db
    .select({ id: usersTable.id, role_name: rolesTable.name })
    .from(usersTable)
    .leftJoin(rolesTable, eq(rolesTable.id, usersTable.role_id))
    .where(and(eq(usersTable.id, id), eq(usersTable.tenant_id, tenant_id)))
    .limit(1);
  if (uRows[0]) {
    return {
      provider: "rbac_query",
      kind: "user",
      id,
      tenant_id,
      roles: uRows[0].role_name ? [uRows[0].role_name] : [],
    };
  }
  const sRows = await db
    .select({
      id: systemAccounts.id,
      role_name: rolesTable.name,
    })
    .from(systemAccounts)
    .leftJoin(rolesTable, eq(rolesTable.id, systemAccounts.role_id))
    .where(and(eq(systemAccounts.id, id), eq(systemAccounts.tenant_id, tenant_id)))
    .limit(1);
  if (sRows[0]) {
    return {
      provider: "rbac_query",
      kind: "system_account",
      id,
      tenant_id,
      roles: [sRows[0].role_name ?? "member"],
    };
  }
  return null;
}
