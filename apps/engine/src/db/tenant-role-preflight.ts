import { errorFields, logger } from "../logging/index.ts";
import {
  decideTenantRolePreflight,
  TENANT_ROLE,
  type TenantRoleDecision,
  type TenantRoleFacts,
  tenantRoleProvisioningStatements,
} from "./core/tenant-scope.ts";

interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}

// row-scope-allowed: reads catalog flags of the table, never its rows
const FACTS_SQL = `
SELECT login.rolname AS login_role,
       login.rolsuper AS is_superuser,
       login.rolbypassrls AS login_bypasses_row_security,
       tenant.oid IS NOT NULL AS role_exists,
       CASE WHEN tenant.oid IS NULL THEN false
            WHEN current_setting('server_version_num')::int >= 160000
              THEN pg_catalog.pg_has_role(login.oid, tenant.oid, 'SET')
            ELSE pg_catalog.pg_has_role(login.oid, tenant.oid, 'MEMBER') END AS can_assume_role,
       COALESCE(tenant.rolsuper OR tenant.rolbypassrls, false) AS role_bypasses_row_security,
       CASE WHEN tenant.oid IS NULL OR to_regnamespace('subkit') IS NULL THEN false
            ELSE pg_catalog.has_schema_privilege(tenant.oid, to_regnamespace('subkit')::oid, 'USAGE')
       END AS grants_present,
       COALESCE((SELECT relrowsecurity AND relforcerowsecurity FROM pg_catalog.pg_class
                  WHERE oid = to_regclass('subkit.vault_items')), false) AS row_security_forced
  FROM pg_catalog.pg_roles login
  LEFT JOIN pg_catalog.pg_roles tenant ON tenant.rolname = $1
 WHERE login.rolname = session_user`;

export async function readTenantRoleFacts(pool: Queryable): Promise<TenantRoleFacts> {
  const result = await pool.query(FACTS_SQL, [TENANT_ROLE]);
  const row = result.rows[0] as TenantRoleFacts | undefined;
  if (!row) throw new Error("the database login role is not visible in pg_roles");
  return row;
}

function report(decision: TenantRoleDecision): TenantRoleDecision {
  const healthy = decision.verdict === "ready" || decision.verdict === "will_provision";
  const entry = {
    module: "db",
    msg: decision.message,
    verdict: decision.verdict,
  };
  if (healthy) logger.debug({ ...entry, action: "tenant_role.preflight" });
  else logger.error({ ...entry, action: "tenant_role.preflight_degraded" });
  return decision;
}

export async function tenantRolePreflight(pool: Queryable): Promise<TenantRoleDecision> {
  return report(decideTenantRolePreflight(await readTenantRoleFacts(pool)));
}

async function provisionTenantRole(pool: Queryable, facts: TenantRoleFacts): Promise<void> {
  await pool.query(tenantRoleProvisioningStatements(facts).join(";\n"));
}

export async function ensureTenantRowSecurity(pool: Queryable): Promise<TenantRoleDecision> {
  const facts = await readTenantRoleFacts(pool);
  if (decideTenantRolePreflight(facts).verdict !== "will_provision")
    return tenantRolePreflight(pool);
  try {
    await provisionTenantRole(pool, facts);
  } catch (error) {
    logger.error({
      module: "db",
      action: "tenant_role.provision_failed",
      msg: `role ${TENANT_ROLE} could not be provisioned; tenant scopes keep the login role`,
      ...errorFields(error),
    });
  }
  return tenantRolePreflight(pool);
}
