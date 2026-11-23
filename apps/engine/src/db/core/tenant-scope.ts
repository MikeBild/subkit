export const TENANT_ROLE = "subkit_tenant";
export const TENANT_SETTING = "subkit.tenant_id";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function scopedTenantId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return UUID_RE.test(normalized) ? normalized : null;
}

export interface TenantRoleFacts {
  login_role: string;
  is_superuser: boolean;
  can_create_role: boolean;
  role_exists: boolean;
  can_assume_role: boolean;
  can_grant_role: boolean;
  role_bypasses_row_security: boolean;
  scheme_applied: boolean;
  grants_present: boolean;
}

export type TenantRoleVerdict =
  | "ready"
  | "will_provision"
  | "role_missing"
  | "cannot_assume_role"
  | "scheme_incomplete"
  | "role_bypasses_row_security";

export interface TenantRoleDecision {
  verdict: TenantRoleVerdict;
  blocking: boolean;
  message: string;
}

function provisioningStatements(login_role: string): string {
  return `CREATE ROLE ${TENANT_ROLE} NOLOGIN NOBYPASSRLS; GRANT ${TENANT_ROLE} TO "${login_role.replaceAll('"', '""')}";`;
}

export function decideTenantRolePreflight(facts: TenantRoleFacts): TenantRoleDecision {
  const usable = facts.role_exists && facts.can_assume_role;
  if (facts.scheme_applied && (!usable || !facts.grants_present)) {
    return {
      verdict: "scheme_incomplete",
      blocking: false,
      message:
        `row security is enabled in this database but role ${TENANT_ROLE} is missing, not assumable by ${facts.login_role} or lacks its grants, ` +
        "which happens after a restore into another cluster. Stored secrets cannot be read until the statements of migration 0007_tenant_row_security are applied again.",
    };
  }
  if (usable) {
    if (facts.role_bypasses_row_security) {
      return {
        verdict: "role_bypasses_row_security",
        blocking: false,
        message: `role ${TENANT_ROLE} is a superuser or has BYPASSRLS, so row security does not restrict it. Run: ALTER ROLE ${TENANT_ROLE} NOSUPERUSER NOBYPASSRLS;`,
      };
    }
    return { verdict: "ready", blocking: false, message: `role ${TENANT_ROLE} is ready` };
  }
  if (!facts.role_exists) {
    return {
      verdict: "role_missing",
      blocking: false,
      message:
        `row security is off: role ${TENANT_ROLE} does not exist. The engine never creates database roles; ` +
        `let a database administrator run: ${provisioningStatements(facts.login_role)}`,
    };
  }
  if (facts.is_superuser) {
    return {
      verdict: "will_provision",
      blocking: false,
      message: `membership in role ${TENANT_ROLE} is granted by the migration`,
    };
  }
  if (facts.can_grant_role) {
    return {
      verdict: "will_provision",
      blocking: false,
      message: `membership in role ${TENANT_ROLE} is granted by the migration`,
    };
  }
  return {
    verdict: "cannot_assume_role",
    blocking: false,
    message:
      `row security is off: role ${TENANT_ROLE} exists but database role ${facts.login_role} may not switch to it. ` +
      `Let a database administrator run: GRANT ${TENANT_ROLE} TO "${facts.login_role.replaceAll('"', '""')}";`,
  };
}
