import { logger } from "../logging/index.ts";
import {
  decideTenantRolePreflight,
  TENANT_ROLE,
  type TenantRoleDecision,
  type TenantRoleFacts,
} from "./core/tenant-scope.ts";

interface Queryable {
  query: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>;
}

const FACTS_SQL = `
SELECT login.rolname AS login_role,
       login.rolsuper AS is_superuser,
       login.rolcreaterole AS can_create_role,
       tenant.oid IS NOT NULL AS role_exists,
       CASE WHEN tenant.oid IS NULL THEN false
            WHEN current_setting('server_version_num')::int >= 160000
              THEN pg_catalog.pg_has_role(login.oid, tenant.oid, 'SET')
            ELSE pg_catalog.pg_has_role(login.oid, tenant.oid, 'MEMBER') END AS can_assume_role,
       CASE WHEN tenant.oid IS NULL THEN false
            ELSE pg_catalog.pg_has_role(login.oid, tenant.oid, 'MEMBER WITH ADMIN OPTION') END AS can_grant_role,
       COALESCE(tenant.rolsuper OR tenant.rolbypassrls, false) AS role_bypasses_row_security,
       COALESCE((SELECT relrowsecurity FROM pg_catalog.pg_class
                  WHERE oid = to_regclass('subkit.vault_items')), false) AS scheme_applied,
       CASE WHEN tenant.oid IS NULL OR to_regnamespace('subkit') IS NULL THEN false
            ELSE pg_catalog.has_schema_privilege(tenant.oid, to_regnamespace('subkit')::oid, 'USAGE')
       END AS grants_present
  FROM pg_catalog.pg_roles login
  LEFT JOIN pg_catalog.pg_roles tenant ON tenant.rolname = $1
 WHERE login.rolname = current_user`;

export async function readTenantRoleFacts(pool: Queryable): Promise<TenantRoleFacts> {
  const result = await pool.query(FACTS_SQL, [TENANT_ROLE]);
  const row = result.rows[0] as TenantRoleFacts | undefined;
  if (!row) throw new Error("the database login role is not visible in pg_roles");
  return row;
}

export async function tenantRolePreflight(pool: Queryable): Promise<TenantRoleDecision> {
  const decision = decideTenantRolePreflight(await readTenantRoleFacts(pool));
  if (decision.verdict === "ready" || decision.verdict === "will_provision") {
    logger.debug({
      module: "db",
      action: "tenant_role.preflight",
      msg: decision.message,
      verdict: decision.verdict,
    });
    return decision;
  }
  logger.error({
    module: "db",
    action: decision.blocking ? "tenant_role.preflight_blocked" : "tenant_role.preflight_degraded",
    msg: decision.message,
    verdict: decision.verdict,
  });
  return decision;
}

export class TenantRolePreflightError extends Error {
  constructor(readonly decision: TenantRoleDecision) {
    super(decision.message);
    this.name = "TenantRolePreflightError";
  }
}

export async function assertTenantRolePreflight(pool: Queryable): Promise<void> {
  const decision = await tenantRolePreflight(pool);
  if (decision.blocking) throw new TenantRolePreflightError(decision);
}
