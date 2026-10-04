import { describe, expect, it } from "bun:test";
import {
  decideToolMode,
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
  it("development probes cannot disguise writes as automatic preparation", () => {
    for (const tool of ["probe_connector"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        for (const permission_mode of ["auto", "ask", "plan"] as const) {
          expect(
            decideToolMode({
              tool,
              category: tool === "probe_connector" ? "tenant_read" : "draft_write",
              input: { environment: "dev", method },
              overrides: { [tool]: "no_confirm" },
              permission_mode,
            }).mode,
          ).toBe("confirm_before_execution");
        }
      }
      expect(
        decideToolMode({
          tool,
          category: "tenant_read",
          input: { environment: "dev", method: "GET" },
          overrides: {},
          permission_mode: "auto",
        }).mode,
      ).toBe("no_confirm");
      expect(
        decideToolMode({
          tool,
          category: "tenant_read",
          input: { environment: "prod", method: "GET" },
          overrides: {},
          permission_mode: "auto",
        }).mode,
      ).toBe("confirm_before_execution");
    }
  });

  it("held draft writes do not create a routine development approval", () => {
    expect(
      decideToolMode({
        tool: "probe_connector_draft",
        category: "draft_write",
        input: { environment: "dev", method: "POST" },
        overrides: {},
        permission_mode: "auto",
      }).mode,
    ).toBe("no_confirm");
  });

  it("run_workflow environment=dev auto-confirms (no_confirm)", () => {
    const mode = resolveToolMode({
      tool: "run_workflow",
      category: "tenant_write",
      input: { workflow_id: "x", environment: "dev" },
      overrides: {},
    });
    expect(mode).toBe("no_confirm");
  });

  it("load_skill stays no_confirm despite tenant_write category (benign context-load, must not gate)", () => {
    const mode = resolveToolMode({
      tool: "load_skill",
      category: "tenant_write",
      input: { slug: "workflow-authoring" },
      overrides: {},
    });
    expect(mode).toBe("no_confirm");
  });

  it("never-gate pins survive permission_mode=ask/plan", () => {
    for (const permission_mode of ["ask", "plan"] as const) {
      for (const tool of ["load_skill", "save_learning", "create_skill"]) {
        const decision = decideToolMode({
          tool,
          category: "tenant_write",
          input: { slug: "workflow-authoring" },
          overrides: {},
          permission_mode,
        });
        expect(decision.mode).toBe("no_confirm");
        expect(decision.rule).toBe("never_gate");
      }
    }
  });

  it("an explicit per-conversation override still gates a never-gate tool", () => {
    const withPermissionMode = decideToolMode({
      tool: "load_skill",
      category: "tenant_write",
      input: { slug: "workflow-authoring" },
      overrides: { load_skill: "confirm_before_execution" },
      permission_mode: "ask",
    });
    expect(withPermissionMode.mode).toBe("confirm_before_execution");
    expect(withPermissionMode.rule).not.toBe("never_gate");

    const withoutPermissionMode = decideToolMode({
      tool: "load_skill",
      category: "tenant_write",
      input: { slug: "workflow-authoring" },
      overrides: { load_skill: "confirm_before_execution" },
    });
    expect(withoutPermissionMode.mode).toBe("confirm_before_execution");
    expect(withoutPermissionMode.rule).toBe("conversation_override");
  });

  it("dry_run_workflow remains preparation in every environment", () => {
    const heldWritesProd = decideToolMode({
      tool: "dry_run_workflow",
      category: "draft_write",
      input: { environment: "prod" },
      overrides: {},
    });
    expect(heldWritesProd.mode).toBe("no_confirm");

    const heldWritesDev = decideToolMode({
      tool: "dry_run_workflow",
      category: "draft_write",
      input: { environment: "dev" },
      overrides: {},
    });
    expect(heldWritesDev.mode).toBe("no_confirm");

    const heldWritesAuto = decideToolMode({
      tool: "dry_run_workflow",
      category: "draft_write",
      input: { environment: "dev" },
      overrides: {},
      permission_mode: "auto",
    });
    expect(heldWritesAuto.mode).toBe("no_confirm");
  });

  it("generic starts use bounded admission and draft previews always hold writes", () => {
    for (const tool of ["run_workflow", "dry_run_workflow"]) {
      const decision = decideToolMode({
        tool,
        category: tool === "run_workflow" ? "tenant_write" : "draft_write",
        input: { workflow: "x", environment: "dev", execute_writes: true },
        overrides: {},
        permission_mode: "auto",
      });
      expect(decision.mode).toBe("no_confirm");
    }
  });

  it("yolo still honours an explicitly-armed override for a live write run", () => {
    const decision = decideToolMode({
      tool: "run_workflow",
      category: "tenant_write",
      input: { workflow: "x", environment: "prod", execute_writes: true },
      overrides: {},
      permission_mode: "yolo",
    });
    expect(decision.mode).toBe("no_confirm");
  });

  it("run_workflow in prod delegates ordinary starts to bounded admission", () => {
    const mode = resolveToolMode({
      tool: "run_workflow",
      category: "tenant_write",
      input: { workflow_id: "x", environment: "prod" },
      overrides: {},
    });
    expect(mode).toBe("no_confirm");
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
        tool: "edit_workflow_patch",
        category: "draft_write",
        input: {},
        overrides: {},
      }),
    ).toBe("no_confirm");
  });

  it("save_workflow_draft requires confirm by default", () => {
    expect(
      resolveToolMode({
        tool: "save_workflow_draft",
        category: "draft_write",
        input: {},
        overrides: {},
      }),
    ).toBe("confirm_before_execution");
  });

  it("save_connector_draft requires confirm whether or not credential is present", () => {
    expect(
      resolveToolMode({
        tool: "save_connector_draft",
        category: "tenant_write",
        input: {},
        overrides: {},
      }),
    ).toBe("confirm_before_execution");
    expect(
      resolveToolMode({
        tool: "save_connector_draft",
        category: "tenant_write",
        input: { credential: { mode: "bearer", token: "secret" } },
        overrides: {},
      }),
    ).toBe("confirm_before_execution");
  });

  it("authenticate_oauth runs first, then pauses for review (confirm_after_execution)", () => {
    expect(
      resolveToolMode({
        tool: "authenticate_oauth",
        category: "tenant_write",
        input: { connector_id: "00000000-0000-0000-0000-000000000000" },
        overrides: {},
      }),
    ).toBe("confirm_after_execution");
  });

  it("cleanup write tools require confirm by default", () => {
    const cleanupTools = [
      "delete_workflow",
      "delete_connector",
      "delete_knowledge_source",
      "delete_subscription",
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

  it("replacing an EXISTING workflow is dangerous — creating one is not", () => {
    const overwrite = decideToolMode({
      tool: "save_workflow_draft",
      category: "tenant_write",
      input: { target_workflow_id: "5b873c3d-b9ce-465c-81a2-7a5a4e597365" },
      permission_mode: "auto",
      overrides: {},
    });
    expect(overwrite.mode).toBe("confirm_before_execution");
    expect(overwrite.rule).toBe("computed_from_input");

    const forced = decideToolMode({
      tool: "save_workflow_draft",
      category: "tenant_write",
      input: { force_commit: true },
      permission_mode: "auto",
      overrides: {},
    });
    expect(forced.mode).toBe("confirm_before_execution");
    expect(forced.rule).toBe("computed_from_input");

    const ordinary = decideToolMode({
      tool: "save_workflow_draft",
      category: "tenant_write",
      input: { workflow_slug: "brand-new-thing" },
      permission_mode: "auto",
      overrides: {},
    });
    expect(ordinary.mode).toBe("no_confirm");

    const yolo = decideToolMode({
      tool: "save_workflow_draft",
      category: "tenant_write",
      input: { target_workflow_id: "5b873c3d-b9ce-465c-81a2-7a5a4e597365" },
      permission_mode: "yolo",
      overrides: {},
    });
    expect(yolo.mode).toBe("no_confirm");
  });
});
