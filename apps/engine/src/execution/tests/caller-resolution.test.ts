import { describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { assertCallerMatches, callerFromPrincipal } from "../caller-context.ts";

const tenant = "00000000-0000-4000-8000-000000000031";
const principal: ResolvedPrincipal = {
  provider: "test",
  kind: "user",
  id: "00000000-0000-4000-8000-000000000032",
  tenant_id: tenant,
  roles: ["enduser"],
  product_id: "harmoniqs",
};

describe("caller identity resolution", () => {
  test("caller references authenticated identity rather than role or workflow identity", () => {
    expect(callerFromPrincipal(principal, tenant, "harmoniqs")).toEqual({
      tenantId: tenant,
      principalId: principal.id,
      principalKind: "user",
      provider: "test",
      productId: "harmoniqs",
    });
  });

  test("generic caller preserves a machine identity and has no implicit product", () => {
    const { product_id: _product, ...unbound } = principal;
    expect(callerFromPrincipal({ ...unbound, kind: "system_account" }, tenant, undefined)).toEqual({
      tenantId: tenant,
      principalId: principal.id,
      principalKind: "system_account",
      provider: "test",
      productId: null,
    });
  });

  test("missing and mismatched identities fail closed for product workflows", () => {
    expect(() => callerFromPrincipal(null, tenant, "harmoniqs")).toThrow("caller_required");
    expect(() =>
      callerFromPrincipal({ ...principal, tenant_id: principal.id }, tenant, "harmoniqs"),
    ).toThrow("caller_tenant_mismatch");
    expect(() =>
      callerFromPrincipal({ ...principal, product_id: "other" }, tenant, "harmoniqs"),
    ).toThrow("caller_product_mismatch");
    const { product_id: _product, ...unbound } = principal;
    expect(() => callerFromPrincipal(unbound, tenant, "harmoniqs")).toThrow(
      "caller_product_mismatch",
    );
  });

  test("persisted callers remain tenant and product bound", () => {
    const caller = callerFromPrincipal(principal, tenant, "harmoniqs");
    expect(() => assertCallerMatches(caller, principal.id, "harmoniqs")).toThrow(
      "caller_tenant_mismatch",
    );
    expect(() => assertCallerMatches(caller, tenant, "other")).toThrow("caller_product_mismatch");
    expect(() => assertCallerMatches(null, tenant, "harmoniqs")).toThrow("caller_required");
    expect(() => assertCallerMatches(caller, tenant, undefined)).toThrow("caller_product_mismatch");
    expect(() => callerFromPrincipal(principal, tenant, undefined)).toThrow(
      "caller_product_mismatch",
    );
  });

  test("required caller kind separates identical user and machine UUIDs", () => {
    const caller = callerFromPrincipal(principal, tenant, "harmoniqs", "user");
    expect(caller?.principalKind).toBe("user");
    expect(() =>
      callerFromPrincipal({ ...principal, kind: "system_account" }, tenant, "harmoniqs", "user"),
    ).toThrow("caller_kind_mismatch");
    expect(() => callerFromPrincipal(null, tenant, undefined, "user")).toThrow("caller_required");
    expect(() => assertCallerMatches(caller, tenant, "harmoniqs", "system_account")).toThrow(
      "caller_kind_mismatch",
    );
    expect(() => assertCallerMatches(null, tenant, undefined, "user")).toThrow("caller_required");
  });

  test("unauthenticated generic system runs have no fabricated caller", () => {
    expect(callerFromPrincipal(null, tenant, undefined)).toBeNull();
  });

  test("workflow steps cannot occupy reserved caller and input scope names", () => {
    for (const id of ["$caller", "$input"]) {
      expect(
        WorkflowDefSchema.safeParse({
          name: "Reserved scope override",
          steps: [
            { id, kind: "transform", expression: "return { principalId: 'another-owner' };" },
          ],
        }).success,
      ).toBe(false);
    }
  });
});
