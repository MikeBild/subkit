import { describe, expect, it } from "bun:test";
import {
  defaultModeForCategory,
  effectiveMode,
  resolveToolMode,
  type ToolPolicies,
} from "../tool-policies.ts";

describe("tool-policies resolver", () => {
  it("defaults tenant_write to confirm_before_execution", () => {
    expect(defaultModeForCategory("tenant_write")).toBe("confirm_before_execution");
  });
  it("defaults read + draft to no_confirm", () => {
    expect(defaultModeForCategory("tenant_read")).toBe("no_confirm");
    expect(defaultModeForCategory("draft_write")).toBe("no_confirm");
  });
  it("per-conversation override wins over default", () => {
    const policies: ToolPolicies = { run_workflow: "no_confirm" };
    expect(effectiveMode("run_workflow", policies, "confirm_before_execution")).toBe("no_confirm");
  });
  it("falls back to default when no override", () => {
    const policies: ToolPolicies = {};
    expect(effectiveMode("list_workflows", policies, "no_confirm")).toBe("no_confirm");
  });
});

describe("resolveToolMode — dynamic TOOL_POLICIES", () => {
  it("run_workflow environment=dev auto-confirms (no_confirm)", () => {
    const mode = resolveToolMode({
      tool: "run_workflow",
      category: "tenant_write",
      input: { workflow_id: "x", environment: "dev" },
      overrides: {},
    });
    expect(mode).toBe("no_confirm");
  });

  it("run_workflow environment=prod requires confirm", () => {
    const mode = resolveToolMode({
      tool: "run_workflow",
      category: "tenant_write",
      input: { workflow_id: "x", environment: "prod" },
      overrides: {},
    });
    expect(mode).toBe("confirm_before_execution");
  });

  it("per-conversation override beats dynamic compute", () => {
    const mode = resolveToolMode({
      tool: "run_workflow",
      category: "tenant_write",
      input: { environment: "prod" },
      overrides: { run_workflow: "no_confirm" },
    });
    expect(mode).toBe("no_confirm");
  });

  it("unknown tool falls back to category default", () => {
    expect(
      resolveToolMode({
        tool: "list_foo",
        category: "tenant_read",
        input: {},
        overrides: {},
      }),
    ).toBe("no_confirm");
    expect(
      resolveToolMode({
        tool: "mutate_foo",
        category: "tenant_write",
        input: {},
        overrides: {},
      }),
    ).toBe("confirm_before_execution");
  });

  it("registered draft tools default no_confirm even though they are draft_write", () => {
    expect(
      resolveToolMode({
        tool: "propose_step",
        category: "draft_write",
        input: {},
        overrides: {},
      }),
    ).toBe("no_confirm");
  });

  it("commit_draft requires confirm by default", () => {
    expect(
      resolveToolMode({
        tool: "commit_draft",
        category: "draft_write",
        input: {},
        overrides: {},
      }),
    ).toBe("confirm_before_execution");
  });

  it("save_connector_draft requires confirm whether or not credential is present", () => {
    // No credential: still confirm by default (defaultMode).
    expect(
      resolveToolMode({
        tool: "save_connector_draft",
        category: "tenant_write",
        input: {},
        overrides: {},
      }),
    ).toBe("confirm_before_execution");
    // With credential: computeModeFromInput holds the line at confirm.
    expect(
      resolveToolMode({
        tool: "save_connector_draft",
        category: "tenant_write",
        input: { credential: { mode: "bearer", token: "secret" } },
        overrides: {},
      }),
    ).toBe("confirm_before_execution");
  });

  it("authenticate_oauth requires confirm by default", () => {
    expect(
      resolveToolMode({
        tool: "authenticate_oauth",
        category: "tenant_write",
        input: { connector_id: "00000000-0000-0000-0000-000000000000" },
        overrides: {},
      }),
    ).toBe("confirm_before_execution");
  });

  it("cleanup write tools require confirm by default", () => {
    const cleanupTools = [
      "delete_workflow",
      "delete_connector",
      "delete_knowledge_source",
      "delete_subscription",
      "delete_tunnel",
      "revoke_api_key",
      "revoke_portal_token",
    ] as const;
    for (const tool of cleanupTools) {
      expect(
        resolveToolMode({
          tool,
          category: "tenant_write",
          input: { id: "00000000-0000-0000-0000-000000000000" },
          overrides: {},
        }),
      ).toBe("confirm_before_execution");
    }
  });
});

// Locks the contract for the `yolo` permission mode: hard-armed
// escape hatch that lifts the dangerous-tool gate. The tenant gate +
// non-stickiness + expiry live elsewhere; the resolver itself just
// honours the override unconditionally except for the inline-
// credential safeguard.
describe("resolveToolMode — yolo mode", () => {
  it("yolo bypasses the dangerous-tools gate", () => {
    for (const tool of [
      "delete_workflow",
      "delete_connector",
      "revoke_api_key",
      "approve_patch_candidate",
    ]) {
      expect(
        resolveToolMode({
          tool,
          category: "tenant_write",
          input: { id: "00000000-0000-0000-0000-000000000000" },
          overrides: {},
          permission_mode: "yolo",
        }),
      ).toBe("no_confirm");
    }
  });

  it("yolo bypasses the per-tool default for tenant_write tools", () => {
    expect(
      resolveToolMode({
        tool: "run_workflow",
        category: "tenant_write",
        input: { workflow_id: "x", environment: "prod" },
        overrides: {},
        permission_mode: "yolo",
      }),
    ).toBe("no_confirm");
  });

  it("yolo still respects the inline-credential safeguard", () => {
    // `update_connector_draft` is the canonical safeguarded write —
    // pasting a token shape into config must still trigger a confirm
    // step even under yolo so the user sees what's being staged. The
    // credentialFields list (see tool-policies.ts:276) names paths
    // like `config.token`, so the input must mirror that shape.
    expect(
      resolveToolMode({
        tool: "update_connector_draft",
        category: "tenant_write",
        input: {
          config: { token: "dop_v1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF" },
        },
        overrides: {},
        permission_mode: "yolo",
      }),
    ).toBe("confirm_before_execution");
  });

  it("auto continues to gate dangerous tools (regression)", () => {
    expect(
      resolveToolMode({
        tool: "delete_connector",
        category: "tenant_write",
        input: { id: "00000000-0000-0000-0000-000000000000" },
        overrides: {},
        permission_mode: "auto",
      }),
    ).toBe("confirm_before_execution");
  });
});
