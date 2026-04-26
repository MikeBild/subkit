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
