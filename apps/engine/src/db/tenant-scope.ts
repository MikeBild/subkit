import { sql } from "drizzle-orm";
import type { Executor, Transaction } from "./client.ts";
import { scopedTenantId, TENANT_ROLE, TENANT_SETTING } from "./core/tenant-scope.ts";

export async function withTenantScope<T>(
  db: Executor,
  tenant_id: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const tenant = scopedTenantId(tenant_id);
  if (!tenant) throw new TypeError("a tenant scope needs a tenant uuid");
  return db.transaction(async (tx) => {
    const entered = await tx.execute<{ previous_role: string; previous_tenant: string | null }>(
      sql`SELECT current_setting('role') AS previous_role,
                 current_setting(${TENANT_SETTING}, true) AS previous_tenant,
                 set_config(
                   'role',
                   CASE WHEN EXISTS (
                     SELECT 1 FROM pg_catalog.pg_roles r
                     WHERE r.rolname = ${TENANT_ROLE}
                       AND pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
                       AND pg_catalog.has_schema_privilege(r.oid, 'subkit', 'USAGE')
                   ) THEN ${TENANT_ROLE} ELSE current_setting('role') END,
                   true
                 ),
                 set_config(${TENANT_SETTING}, ${tenant}, true)`,
    );
    const previous = entered.rows[0];
    if (!previous) throw new Error("tenant scope could not be entered");
    const result = await fn(tx);
    await tx.execute(
      sql`SELECT set_config('role', ${previous.previous_role}, true),
                 set_config(${TENANT_SETTING}, ${previous.previous_tenant ?? ""}, true)`,
    );
    return result;
  });
}
