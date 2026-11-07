import { describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import {
  assertCallerExecutionSource,
  assertCallerMatches,
  callerFromPrincipal,
} from "../caller-context.ts";

const tenant = "00000000-0000-4000-8000-000000000031";
const principal: ResolvedPrincipal = {
  provider: "test",
  kind: "user",
  id: "00000000-0000-4000-8000-000000000032",
  tenant_id: tenant,
  roles: ["enduser"],
  product_id: "harmoniqs",
};

function refusal(run: () => unknown): { code: unknown; message: string } {
  try {
    run();
  } catch (error) {
    return { code: (error as { code?: unknown }).code, message: (error as Error).message };
  }
  throw new Error("expected a refusal");
}

const productMismatch = {
  code: "caller_product_mismatch",
  message:
    "This caller does not match the workflow's product. A product-bound workflow runs only for a caller of that product: save the workflow, then run it as that product's caller.",
};

describe("caller identity resolution", () => {
  test("product refusals keep their code and explain what to do", () => {
    expect(refusal(() => assertCallerExecutionSource(principal, "draft"))).toEqual({
      code: "caller_saved_workflow_required",
      message:
        "This caller can only run a saved workflow version, not a draft. Product callers run only saved workflows of their own product: save the workflow, then run the saved version.",
    });
    expect(refusal(() => assertCallerExecutionSource(principal, "step")).code).toBe(
      "caller_saved_workflow_required",
    );
    expect(() => assertCallerExecutionSource(principal, "saved")).not.toThrow();
    const { product_id: _product, ...unbound } = principal;
    expect(() => assertCallerExecutionSource(unbound, "draft")).not.toThrow();
    expect(refusal(() => callerFromPrincipal(null, tenant, "harmoniqs")).message).toBe(
      "caller_required",
    );
  });

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
    expect(
      refusal(() =>
        callerFromPrincipal({ ...principal, product_id: "other" }, tenant, "harmoniqs"),
      ),
    ).toEqual(productMismatch);
    const { product_id: _product, ...unbound } = principal;
    expect(refusal(() => callerFromPrincipal(unbound, tenant, "harmoniqs"))).toEqual(
      productMismatch,
    );
  });

  test("persisted callers remain tenant and product bound", () => {
    const caller = callerFromPrincipal(principal, tenant, "harmoniqs");
    expect(() => assertCallerMatches(caller, principal.id, "harmoniqs")).toThrow(
      "caller_tenant_mismatch",
    );
    expect(refusal(() => assertCallerMatches(caller, tenant, "other"))).toEqual(productMismatch);
    expect(() => assertCallerMatches(null, tenant, "harmoniqs")).toThrow("caller_required");
    expect(refusal(() => assertCallerMatches(caller, tenant, undefined))).toEqual(productMismatch);
    expect(refusal(() => callerFromPrincipal(principal, tenant, undefined))).toEqual(
      productMismatch,
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
