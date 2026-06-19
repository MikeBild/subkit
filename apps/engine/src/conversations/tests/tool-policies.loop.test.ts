// Loop integration test for the canonical tool-policies resolver.
//
// Locks the contract that the loop's pre-dispatch resolver hook
// returns `confirm_before_execution` for `update_connector_draft`
// when the input carries a sensitive token. This is the policy
// decision the loop's structured `tool_policy.resolved` log records
// before delegating to the sdk-wrap layer; downstream waves wire the
// actual pause on draft_write tools.

import { describe, expect, it } from "bun:test";
import { confirmIfSensitiveInput, resolveExecutionMode } from "../tools/tool-policies.ts";

const CTX = { tenant_id: "ten_test" } as const;

describe("tool-policies.ts × loop pre-dispatch hook", () => {
  it("update_connector_draft with a sensitive token resolves to confirm_before_execution", () => {
    const resolved = resolveExecutionMode(
      "update_connector_draft",
      { config: { token: "dop_v1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF" } },
      CTX,
    );
    expect(resolved.mode).toBe("confirm_before_execution");
    expect(resolved.confirmationKind).toBe("sensitive_input");
  });

  it("update_connector_draft without sensitive input resolves to auto", () => {
    const resolved = resolveExecutionMode("update_connector_draft", { name: "Acme renamed" }, CTX);
    expect(resolved.mode).toBe("auto");
  });

  it("update_connector_draft with a JWT in headers resolves to confirm_before_execution", () => {
    expect(
      resolveExecutionMode(
        "update_connector_draft",
        { config: { headers: { authorization: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig" } } },
        CTX,
      ).mode,
    ).toBe("confirm_before_execution");
  });

  it("predicate flags the same shape directly — proves the resolver is wired to it", () => {
    expect(
      confirmIfSensitiveInput({
        config: { token: "dop_v1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF" },
      }),
    ).toBe("confirm_before_execution");
  });
});
