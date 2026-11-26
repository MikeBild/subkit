import { describe, expect, test } from "bun:test";
import migrationSql from "../migrations/0010_tenant_row_security_force.sql" with { type: "text" };
import ownedResourcesSql from "../migrations/0017_owned_resources.sql" with { type: "text" };
import {
  decideScopeEntry,
  decideTenantRolePreflight,
  RETIRED_ROW_SCOPE_POLICY,
  ROW_SCOPE_POLICY,
  ROW_SCOPED_TABLES,
  renderRowScopeMigration,
  rowScopePolicyStatements,
  rowScopePredicate,
  scopedTenantId,
  type TenantRoleFacts,
  tenantRoleProvisioningStatements,
} from "./tenant-scope.ts";

const TENANT = "3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b";

function facts(overrides: Partial<TenantRoleFacts> = {}): TenantRoleFacts {
  return {
    login_role: "engine",
    is_superuser: false,
    login_bypasses_row_security: false,
    role_exists: false,
    can_assume_role: false,
    role_bypasses_row_security: false,
    grants_present: false,
    row_security_forced: true,
    ...overrides,
  };
}

const usableRole = { role_exists: true, can_assume_role: true, grants_present: true };

describe("scopedTenantId", () => {
  test("accepts a uuid and lower-cases it", () => {
    expect(scopedTenantId(TENANT)).toBe(TENANT);
    expect(scopedTenantId(TENANT.toUpperCase())).toBe(TENANT);
  });

  test.each([
    "",
    "not-a-uuid",
    `${TENANT}'; RESET ROLE; --`,
    ` ${TENANT}`,
    `${TENANT}\n`,
    null,
    undefined,
    42,
  ])("rejects %p", (value) => {
    expect(scopedTenantId(value)).toBeNull();
  });
});

describe("decideScopeEntry", () => {
  test("a tenant scope sets the normalized tenant and may assume the tenant role", () => {
    expect(decideScopeEntry({ kind: "tenant", tenant_id: TENANT.toUpperCase() })).toEqual({
      kind: "entered",
      entry: { rls_scope: "tenant", tenant_id: TENANT, assume_tenant_role: true },
    });
  });

  test("a system scope clears the tenant and keeps the login role", () => {
    expect(decideScopeEntry({ kind: "system", reason: "sweep" })).toEqual({
      kind: "entered",
      entry: { rls_scope: "system", tenant_id: "", assume_tenant_role: false },
    });
  });

  test("a tenant scope without a tenant uuid is rejected as a value", () => {
    expect(decideScopeEntry({ kind: "tenant", tenant_id: `${TENANT}'; --` })).toEqual({
      kind: "rejected",
      reason: "a tenant scope needs a tenant uuid",
    });
  });

  test("a system scope without a reason is rejected as a value", () => {
    expect(decideScopeEntry({ kind: "system", reason: "  " })).toEqual({
      kind: "rejected",
      reason: "a system scope needs a reason",
    });
  });
});

describe("row scope policy", () => {
  test("the migration files are exactly what the builder renders", () => {
    const later = ["webhook_held_deliveries", "owned_resources"];
    expect(migrationSql).toBe(
      renderRowScopeMigration(ROW_SCOPED_TABLES.filter((table) => !later.includes(table))),
    );
    expect(ownedResourcesSql.endsWith(renderRowScopeMigration(["owned_resources"]))).toBe(true);
  });

  test("every row-scoped table drops the retired policy, gets one policy and is forced", () => {
    const statements = rowScopePolicyStatements();
    expect(statements).toHaveLength(ROW_SCOPED_TABLES.length * 5);
    for (const table of ROW_SCOPED_TABLES) {
      const target = `"subkit"."${table}"`;
      expect(statements).toContain(
        `DROP POLICY IF EXISTS "${RETIRED_ROW_SCOPE_POLICY}" ON ${target};`,
      );
      expect(statements).toContain(
        `CREATE POLICY "${ROW_SCOPE_POLICY}" ON ${target} USING (${rowScopePredicate()}) WITH CHECK (${rowScopePredicate()});`,
      );
      expect(statements).toContain(`ALTER TABLE ${target} FORCE ROW LEVEL SECURITY;`);
    }
  });

  test("the policy names no role and admits the system scope or the matching tenant", () => {
    const statements = rowScopePolicyStatements(["vault_items"]);
    expect(statements.join("\n")).not.toMatch(/\bTO\b/);
    expect(rowScopePredicate()).toBe(
      "current_setting('subkit.rls_scope', true) = 'system' OR \"tenant_id\" = nullif(current_setting('subkit.tenant_id', true), '')::uuid",
    );
  });
});

describe("tenantRoleProvisioningStatements", () => {
  test("a missing role is created, granted to the login and given its table grants", () => {
    const statements = tenantRoleProvisioningStatements(facts({ login_role: 'odd"name' }));
    expect(statements[0]).toBe("CREATE ROLE subkit_tenant NOLOGIN NOBYPASSRLS");
    expect(statements[1]).toBe('GRANT subkit_tenant TO "odd""name"');
    expect(statements).toContain('GRANT USAGE ON SCHEMA "subkit" TO subkit_tenant');
  });

  test("an assumable role only gets its grants refreshed", () => {
    const statements = tenantRoleProvisioningStatements(facts(usableRole));
    expect(statements.some((s) => s.startsWith("CREATE ROLE"))).toBe(false);
    expect(statements.some((s) => s.startsWith("GRANT subkit_tenant TO"))).toBe(false);
  });
});

describe("decideTenantRolePreflight", () => {
  test("a plain owner login is ready without any role because forced row security applies to it", () => {
    expect(decideTenantRolePreflight(facts())).toMatchObject({ verdict: "ready", blocking: false });
  });

  test("tables without forced row security are reported without blocking", () => {
    expect(decideTenantRolePreflight(facts({ row_security_forced: false }))).toMatchObject({
      verdict: "scheme_incomplete",
      blocking: false,
    });
  });

  test("a superuser without a usable role has the role provisioned", () => {
    for (const partial of [{}, { role_exists: true }, { ...usableRole, grants_present: false }]) {
      expect(decideTenantRolePreflight(facts({ is_superuser: true, ...partial }))).toMatchObject({
        verdict: "will_provision",
      });
    }
  });

  test("a superuser with a usable role is ready", () => {
    expect(decideTenantRolePreflight(facts({ is_superuser: true, ...usableRole }))).toMatchObject({
      verdict: "ready",
    });
  });

  test("a BYPASSRLS login without a usable role degrades and names the statements", () => {
    const decision = decideTenantRolePreflight(facts({ login_bypasses_row_security: true }));
    expect(decision).toMatchObject({ verdict: "role_missing", blocking: false });
    expect(decision.message).toContain("CREATE ROLE subkit_tenant");
    expect(decision.message).toContain('GRANT subkit_tenant TO "engine"');
  });

  test("a tenant role that bypasses row security is reported", () => {
    expect(
      decideTenantRolePreflight(
        facts({ is_superuser: true, ...usableRole, role_bypasses_row_security: true }),
      ),
    ).toMatchObject({ verdict: "role_bypasses_row_security", blocking: false });
  });
});
