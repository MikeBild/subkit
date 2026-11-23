import { describe, expect, test } from "bun:test";
import { decideTenantRolePreflight, scopedTenantId, type TenantRoleFacts } from "./tenant-scope.ts";

const TENANT = "3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b";

function facts(overrides: Partial<TenantRoleFacts> = {}): TenantRoleFacts {
  return {
    login_role: "engine",
    is_superuser: false,
    can_create_role: false,
    role_exists: true,
    can_assume_role: true,
    can_grant_role: false,
    role_bypasses_row_security: false,
    scheme_applied: true,
    grants_present: true,
    ...overrides,
  };
}

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

describe("decideTenantRolePreflight", () => {
  test("an existing assumable role never blocks, whatever the login role may create", () => {
    expect(decideTenantRolePreflight(facts())).toMatchObject({ verdict: "ready", blocking: false });
    expect(
      decideTenantRolePreflight(facts({ scheme_applied: false, grants_present: false })),
    ).toMatchObject({
      verdict: "ready",
      blocking: false,
    });
  });

  test("a missing role is provisioned by a login role with CREATEROLE or by a superuser", () => {
    const missing = {
      role_exists: false,
      can_assume_role: false,
      scheme_applied: false,
      grants_present: false,
    };
    expect(decideTenantRolePreflight(facts({ ...missing, can_create_role: true })).verdict).toBe(
      "will_provision",
    );
    expect(
      decideTenantRolePreflight(facts({ ...missing, is_superuser: true, can_assume_role: false }))
        .verdict,
    ).toBe("will_provision");
  });

  test("a missing role without CREATEROLE blocks and names both remedies", () => {
    const decision = decideTenantRolePreflight(
      facts({
        role_exists: false,
        can_assume_role: false,
        scheme_applied: false,
        grants_present: false,
      }),
    );
    expect(decision).toMatchObject({ verdict: "cannot_create_role", blocking: true });
    expect(decision.message).toContain("CREATEROLE");
    expect(decision.message).toContain('GRANT subkit_tenant TO "engine"');
  });

  test("an existing role the login role may not switch to blocks unless it can grant itself", () => {
    const base = { can_assume_role: false, scheme_applied: false, grants_present: false };
    expect(decideTenantRolePreflight(facts(base))).toMatchObject({
      verdict: "cannot_assume_role",
      blocking: true,
    });
    expect(decideTenantRolePreflight(facts({ ...base, can_grant_role: true }))).toMatchObject({
      verdict: "will_provision",
      blocking: false,
    });
  });

  test("an applied scheme with a missing role or missing grants is reported without blocking", () => {
    for (const broken of [
      { role_exists: false, can_assume_role: false },
      { can_assume_role: false },
      { grants_present: false },
    ]) {
      expect(decideTenantRolePreflight(facts(broken))).toMatchObject({
        verdict: "scheme_incomplete",
        blocking: false,
      });
    }
  });

  test("a role that bypasses row security is reported", () => {
    expect(decideTenantRolePreflight(facts({ role_bypasses_row_security: true }))).toMatchObject({
      verdict: "role_bypasses_row_security",
      blocking: false,
    });
  });

  test("quotes the login role in the suggested statements", () => {
    const decision = decideTenantRolePreflight(
      facts({ login_role: 'odd"name', can_assume_role: false, scheme_applied: false }),
    );
    expect(decision.message).toContain('"odd""name"');
  });
});
