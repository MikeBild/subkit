import { describe, expect, test } from "bun:test";
import { withContext } from "../../../logging/context.ts";
import { LlmAccessMissing, LlmError } from "../../errors.ts";
import {
  assertOperatorKeyAllowed,
  modelTenantContext,
  type OperatorKeyGuardDependencies,
} from "../operator-key-guard.ts";

const TENANT = "7d0c1c0e-4f43-4a53-9a0b-2f6f2f3b9a11";

function guard(origin: string | undefined, hostedAuth = false) {
  const lookups: string[] = [];
  const deps: OperatorKeyGuardDependencies = {
    hostedAuth: () => hostedAuth,
    tenantOrigin: async (tenantId) => {
      lookups.push(tenantId);
      return origin;
    },
  };
  return { deps, lookups };
}

describe("the operator's AI access", () => {
  test("is refused for a self-service workspace with the AI access error", async () => {
    const { deps } = guard("self_service");
    const refusal = await assertOperatorKeyAllowed(TENANT, undefined, deps).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(LlmAccessMissing);
    expect(refusal).toMatchObject({ code: "ai_access_missing" });
    expect((refusal as Error).message).toContain("Settings → AI assistant");
  });

  test("stays available to a self-hosted workspace", async () => {
    const { deps, lookups } = guard("self_hosted");
    await assertOperatorKeyAllowed(TENANT, undefined, deps);
    expect(lookups).toEqual([TENANT]);
  });

  test("is refused for an unknown or malformed tenant without naming a key to enter", async () => {
    const unknown = guard(undefined);
    await expect(assertOperatorKeyAllowed(TENANT, undefined, unknown.deps)).rejects.toMatchObject({
      code: "llm_unavailable",
    });
    const malformed = guard("self_hosted");
    await expect(
      assertOperatorKeyAllowed("not-a-tenant", undefined, malformed.deps),
    ).rejects.toBeInstanceOf(LlmError);
    expect(malformed.lookups).toEqual([]);
  });

  test("needs a tenant only where hosted sign-in is on", async () => {
    const selfHosted = guard(undefined, false);
    await assertOperatorKeyAllowed(undefined, undefined, selfHosted.deps);
    expect(selfHosted.lookups).toEqual([]);
    const hosted = guard(undefined, true);
    await expect(assertOperatorKeyAllowed(undefined, undefined, hosted.deps)).rejects.toMatchObject(
      { code: "llm_unavailable" },
    );
  });
});

describe("the model tenant", () => {
  test("is the authenticated context unless an explicit tenant contradicts it", () => {
    withContext({ tenant_id: TENANT }, () => {
      expect(modelTenantContext()).toBe(TENANT);
      expect(modelTenantContext(TENANT)).toBe(TENANT);
      expect(() => modelTenantContext("another-tenant")).toThrow("do not match");
    });
    expect(modelTenantContext("explicit")).toBe("explicit");
  });
});
