import { describe, expect, test } from "bun:test";
import { resolveExecutionCallerActor, resolveExecutionCallerOrigin } from "../caller-origin.ts";

const tenantId = "00000000-0000-4000-8000-000000000041";
const caller = {
  tenantId,
  principalId: "00000000-0000-4000-8000-000000000042",
  principalKind: "user",
  provider: "test",
  productId: null,
};

describe("persisted execution caller provenance", () => {
  test("only explicit valid principal provenance establishes a caller actor", () => {
    expect(resolveExecutionCallerOrigin(tenantId, caller, "principal")).toBe("principal");
    expect(resolveExecutionCallerActor(tenantId, caller, "principal")).toEqual({
      actor_type: "user",
      actor_id: caller.principalId,
    });
    expect(
      resolveExecutionCallerActor(
        tenantId,
        { ...caller, principalKind: "system_account" },
        "principal",
      ),
    ).toEqual({ actor_type: "system_account", actor_id: caller.principalId });
  });

  test("explicit internal system provenance requires a null caller", () => {
    expect(resolveExecutionCallerOrigin(tenantId, null, "trusted_system")).toBe("trusted_system");
    expect(resolveExecutionCallerActor(tenantId, null, "trusted_system")).toEqual({
      actor_type: "system",
      actor_id: null,
    });
    for (const candidate of [undefined, caller, {}, { principalKind: "system" }]) {
      expect(resolveExecutionCallerOrigin(tenantId, candidate, "trusted_system")).toBe("unknown");
      expect(resolveExecutionCallerActor(tenantId, candidate, "trusted_system")).toEqual({
        actor_type: "unknown",
        actor_id: null,
      });
    }
  });

  test("historical callers and absent provenance never imply a principal or system actor", () => {
    for (const origin of [undefined, null, "unknown", "scheduler", "webhook", "system", {}]) {
      for (const candidate of [null, caller]) {
        expect(resolveExecutionCallerOrigin(tenantId, candidate, origin)).toBe("unknown");
        expect(resolveExecutionCallerActor(tenantId, candidate, origin)).toEqual({
          actor_type: "unknown",
          actor_id: null,
        });
      }
    }
  });

  test("principal provenance rejects cross-tenant and malformed caller records", () => {
    for (const candidate of [
      null,
      undefined,
      {},
      { ...caller, tenantId: caller.principalId },
      { ...caller, principalKind: "system" },
      { ...caller, principalId: "unproven-owner" },
      { ...caller, caller_origin: "trusted_system" },
    ]) {
      expect(resolveExecutionCallerOrigin(tenantId, candidate, "principal")).toBe("unknown");
      expect(resolveExecutionCallerActor(tenantId, candidate, "principal")).toEqual({
        actor_type: "unknown",
        actor_id: null,
      });
    }
  });
});
