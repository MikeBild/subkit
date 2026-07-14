// Route policy evaluator — pure RBAC role-gate logic, no DB. Pins the
// enduser-deny-by-default rule, the allowSelf escape hatch, the
// readOnly member carve-out, and the three convenience wrappers routes
// call directly.

import { describe, expect, test } from "bun:test";
import { checkRoute, policy } from "./policy.ts";
import type { ResolvedPrincipal } from "./types.ts";

function principalWith(roles: string[]): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
    id: "11111111-1111-1111-1111-111111111111",
    tenant_id: "22222222-2222-2222-2222-222222222222",
    roles,
  };
}

describe("checkRoute — enduser default deny", () => {
  test("an enduser principal is denied even with no requireRole spec", () => {
    const decision = checkRoute(principalWith(["enduser"]), {});
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("enduser_denied");
  });

  test("an enduser principal passes when selfMatch is true", () => {
    const decision = checkRoute(principalWith(["enduser"]), {}, true);
    expect(decision.allowed).toBe(true);
  });
});

describe("checkRoute — allowSelf", () => {
  test("allowSelf + selfMatch bypasses the role requirement entirely", () => {
    const decision = checkRoute(
      principalWith(["member"]),
      { requireRole: ["admin"], allowSelf: true },
      true,
    );
    expect(decision.allowed).toBe(true);
  });

  test("allowSelf without selfMatch still enforces requireRole", () => {
    const decision = checkRoute(
      principalWith(["member"]),
      { requireRole: ["admin"], allowSelf: true },
      false,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("requires_role:admin");
  });
});

describe("checkRoute — requireRole + readOnly carve-out", () => {
  test("a principal holding the required role passes", () => {
    const decision = checkRoute(principalWith(["admin"]), { requireRole: ["admin"] });
    expect(decision.allowed).toBe(true);
  });

  test("a member is denied on a non-read-only admin-only route", () => {
    const decision = checkRoute(principalWith(["member"]), { requireRole: ["admin"] });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("requires_role:admin");
  });

  test("a member passes an admin-only route marked readOnly", () => {
    const decision = checkRoute(principalWith(["member"]), {
      requireRole: ["admin"],
      readOnly: true,
    });
    expect(decision.allowed).toBe(true);
  });

  test("an empty requireRole array means any authenticated principal passes", () => {
    const decision = checkRoute(principalWith(["member"]), { requireRole: [] });
    expect(decision.allowed).toBe(true);
  });

  test("multiple acceptable roles: matching any one of them passes", () => {
    const decision = checkRoute(principalWith(["member"]), { requireRole: ["admin", "member"] });
    expect(decision.allowed).toBe(true);
  });
});

describe("policy convenience wrappers", () => {
  test("policy.adminOnly denies a member", () => {
    expect(policy.adminOnly(principalWith(["member"])).allowed).toBe(false);
  });

  test("policy.adminOnly allows an admin", () => {
    expect(policy.adminOnly(principalWith(["admin"])).allowed).toBe(true);
  });

  test("policy.adminReadOnly allows a member (read-only carve-out)", () => {
    expect(policy.adminReadOnly(principalWith(["member"])).allowed).toBe(true);
  });

  test("policy.adminOrSelf allows a non-admin acting on themselves", () => {
    expect(policy.adminOrSelf(principalWith(["member"]), true).allowed).toBe(true);
  });

  test("policy.adminOrSelf denies a non-admin acting on someone else", () => {
    expect(policy.adminOrSelf(principalWith(["member"]), false).allowed).toBe(false);
  });
});
