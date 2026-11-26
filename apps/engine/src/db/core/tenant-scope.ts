export const TENANT_ROLE = "subkit_tenant";
export const TENANT_SETTING = "subkit.tenant_id";
export const RLS_SCOPE_SETTING = "subkit.rls_scope";
export const ROW_SCOPE_POLICY = "tenant_row_scope";
export const RETIRED_ROW_SCOPE_POLICY = "tenant_scope";
const SCHEMA = "subkit";

export const ROW_SCOPED_TABLES = [
  "vault_items",
  "tool_approvals",
  "webhooks_inbound",
  "webhook_held_deliveries",
  "subscriptions",
  "chat_workspaces",
  "cockpit_push_keys",
  "cockpit_push_subscriptions",
  "workflow_run_state",
  "auth_provider_configs",
] as const;

export type RowScopedTable = (typeof ROW_SCOPED_TABLES)[number];

export type RowScope = { kind: "tenant"; tenant_id: string } | { kind: "system"; reason: string };

export type RowScopeKind = RowScope["kind"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function scopedTenantId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return UUID_RE.test(normalized) ? normalized : null;
}

export interface ScopeEntry {
  rls_scope: RowScopeKind;
  tenant_id: string;
  assume_tenant_role: boolean;
}

export type ScopeEntryDecision =
  | { kind: "entered"; entry: ScopeEntry }
  | { kind: "rejected"; reason: string };

export function decideScopeEntry(scope: RowScope): ScopeEntryDecision {
  if (scope.kind === "system") {
    if (scope.reason.trim() === "")
      return { kind: "rejected", reason: "a system scope needs a reason" };
    return {
      kind: "entered",
      entry: { rls_scope: "system", tenant_id: "", assume_tenant_role: false },
    };
  }
  const tenant = scopedTenantId(scope.tenant_id);
  if (!tenant) return { kind: "rejected", reason: "a tenant scope needs a tenant uuid" };
  return {
    kind: "entered",
    entry: { rls_scope: "tenant", tenant_id: tenant, assume_tenant_role: true },
  };
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;
const qualified = (table: string) => `${quoteIdent(SCHEMA)}.${quoteIdent(table)}`;

export function rowScopePredicate(): string {
  return (
    `current_setting('${RLS_SCOPE_SETTING}', true) = 'system' OR ` +
    `"tenant_id" = nullif(current_setting('${TENANT_SETTING}', true), '')::uuid`
  );
}

export function rowScopePolicyStatements(tables: readonly string[] = ROW_SCOPED_TABLES): string[] {
  const predicate = rowScopePredicate();
  return tables.flatMap((table) => [
    `DROP POLICY IF EXISTS ${quoteIdent(RETIRED_ROW_SCOPE_POLICY)} ON ${qualified(table)};`,
    `DROP POLICY IF EXISTS ${quoteIdent(ROW_SCOPE_POLICY)} ON ${qualified(table)};`,
    `CREATE POLICY ${quoteIdent(ROW_SCOPE_POLICY)} ON ${qualified(table)} USING (${predicate}) WITH CHECK (${predicate});`,
    `ALTER TABLE ${qualified(table)} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${qualified(table)} FORCE ROW LEVEL SECURITY;`,
  ]);
}

export function renderRowScopeMigration(tables: readonly string[] = ROW_SCOPED_TABLES): string {
  return `${rowScopePolicyStatements(tables).join("\n--> statement-breakpoint\n")}\n`;
}

export interface TenantRoleFacts {
  login_role: string;
  is_superuser: boolean;
  login_bypasses_row_security: boolean;
  role_exists: boolean;
  can_assume_role: boolean;
  role_bypasses_row_security: boolean;
  grants_present: boolean;
  row_security_forced: boolean;
}

export type TenantRoleVerdict =
  | "ready"
  | "will_provision"
  | "role_missing"
  | "scheme_incomplete"
  | "role_bypasses_row_security";

export interface TenantRoleDecision {
  verdict: TenantRoleVerdict;
  blocking: false;
  message: string;
}

export function tenantRoleProvisioningStatements(
  facts: Pick<TenantRoleFacts, "login_role" | "role_exists" | "can_assume_role">,
): string[] {
  const schema = quoteIdent(SCHEMA);
  return [
    ...(facts.role_exists ? [] : [`CREATE ROLE ${TENANT_ROLE} NOLOGIN NOBYPASSRLS`]),
    ...(facts.role_exists && facts.can_assume_role
      ? []
      : [`GRANT ${TENANT_ROLE} TO ${quoteIdent(facts.login_role)}`]),
    `GRANT USAGE ON SCHEMA ${schema} TO ${TENANT_ROLE}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${TENANT_ROLE}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${TENANT_ROLE}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${TENANT_ROLE}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${TENANT_ROLE}`,
  ];
}

export function decideTenantRolePreflight(facts: TenantRoleFacts): TenantRoleDecision {
  const privileged = facts.is_superuser || facts.login_bypasses_row_security;
  if (!facts.row_security_forced) {
    return {
      verdict: "scheme_incomplete",
      blocking: false,
      message:
        "row security is not forced on the tenant tables, so unscoped access is not denied. " +
        "Run the engine migrations again; they re-apply the policies without needing a role.",
    };
  }
  if (!privileged) {
    return {
      verdict: "ready",
      blocking: false,
      message: `row security applies to ${facts.login_role} itself, no extra role is needed`,
    };
  }
  const usable = facts.role_exists && facts.can_assume_role && facts.grants_present;
  if (usable && facts.role_bypasses_row_security) {
    return {
      verdict: "role_bypasses_row_security",
      blocking: false,
      message: `role ${TENANT_ROLE} is a superuser or has BYPASSRLS, so row security does not restrict it. Run: ALTER ROLE ${TENANT_ROLE} NOSUPERUSER NOBYPASSRLS;`,
    };
  }
  if (usable) {
    return {
      verdict: "ready",
      blocking: false,
      message: `${facts.login_role} bypasses row security, so tenant scopes switch to role ${TENANT_ROLE}`,
    };
  }
  if (facts.is_superuser) {
    return {
      verdict: "will_provision",
      blocking: false,
      message: `${facts.login_role} is a superuser, so the engine provisions role ${TENANT_ROLE} for tenant scopes`,
    };
  }
  return {
    verdict: "role_missing",
    blocking: false,
    message:
      `${facts.login_role} has BYPASSRLS, so row security does not restrict it, and role ${TENANT_ROLE} is not usable. ` +
      `Remove BYPASSRLS from the login, or let a database administrator run: ${tenantRoleProvisioningStatements(facts).join("; ")};`,
  };
}
