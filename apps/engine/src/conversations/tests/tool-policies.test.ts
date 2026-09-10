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
    for (const tool of ["probe_connector", "probe_connector_draft"]) {
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
    // Regression: flipping load_skill to tenant_write (so it audits its
    // loaded_skills write) must NOT make the autonomous loop / MCP clients hit a
    // confirm gate — an explicit no_confirm policy overrides the tenant_write
    // category default.
    const mode = resolveToolMode({
      tool: "load_skill",
      category: "tenant_write",
      input: { slug: "workflow-authoring" },
      overrides: {},
    });
    expect(mode).toBe("no_confirm");
  });

  it("never-gate pins survive permission_mode=ask/plan", () => {
    // Production regression: a client advertising `ask` gated `load_skill` with
    // `resolver_reason: "permission_mode"`, because the permission_mode
    // short-circuit fires BEFORE the per-tool `no_confirm` pin. The pin exists
    // precisely so a benign context-load never pauses an authoring turn.
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
    // The override is the documented opt-out (see dangerous-tools.ts): an
    // operator who deliberately gated load_skill keeps the pause, even though
    // the tool is pinned never-gate for the permission_mode short-circuit.
    const withPermissionMode = decideToolMode({
      tool: "load_skill",
      category: "tenant_write",
      input: { slug: "workflow-authoring" },
      overrides: { load_skill: "confirm_before_execution" },
      permission_mode: "ask",
    });
    expect(withPermissionMode.mode).toBe("confirm_before_execution");
    // The never-gate bypass must not swallow the operator's explicit choice.
    // (Which branch gets the credit depends on whether the client also sent a
    // permission_mode; either way the pause is honoured, never skipped.)
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

  it("dry_run_workflow remains preparation regardless of legacy flags or environment", () => {
    // Draft writes stay held even when a caller requests live execution.
    const heldWritesProd = decideToolMode({
      tool: "dry_run_workflow",
      category: "draft_write",
      input: { environment: "prod" },
      overrides: {},
    });
    expect(heldWritesProd.mode).toBe("no_confirm");

    const liveWriteRun = decideToolMode({
      tool: "dry_run_workflow",
      category: "draft_write",
      input: { environment: "prod", execute_writes: true },
      overrides: {},
    });
    expect(liveWriteRun.mode).toBe("no_confirm");

    // Auto does not need a redundant decision over a held preview.
    const liveWriteRunAuto = decideToolMode({
      tool: "dry_run_workflow",
      category: "draft_write",
      input: { environment: "dev", execute_writes: true },
      overrides: {},
      permission_mode: "auto",
    });
    expect(liveWriteRunAuto.mode).toBe("no_confirm");
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
    // yolo is gated at a higher layer (tenant policy + typed confirmation +
    // expiry); by the time it reaches the resolver the user has armed it.
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

  it("authenticate_oauth runs first, then pauses for review (confirm_after_execution)", () => {
    // The OAuth dance produces a staged
    // credential; the operator reviews the captured scopes / expiry
    // BEFORE the loop continues. Pre-fix this was
    // confirm_before_execution which had the operator approve a
    // flow they couldn't see the result of yet.
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

  it("replacing an EXISTING workflow is dangerous — creating one is not", () => {
    // Production, two calls four seconds apart, both under permission_mode
    // "auto": the first hit `slug_conflict_with_live_workflow`, whose recovery
    // text names the argument that lifts the block and says to use it "after
    // the user confirms". The model supplied the argument and skipped the
    // confirming, overwriting a verified 14-step workflow. Nothing gated it,
    // because `auto` short-circuits every tool that is not *dangerous* and this
    // one never declared itself dangerous.
    const overwrite = decideToolMode({
      tool: "save_workflow_draft",
      category: "tenant_write",
      input: { target_workflow_id: "5b873c3d-b9ce-465c-81a2-7a5a4e597365" },
      permission_mode: "auto",
      overrides: {},
    });
    expect(overwrite.mode).toBe("confirm_before_execution");
    // The audit explains the actual overwrite, not merely a tool default.
    expect(overwrite.rule).toBe("computed_from_input");

    // `force_commit` overrules a preview that was NOT green — same class.
    const forced = decideToolMode({
      tool: "save_workflow_draft",
      category: "tenant_write",
      input: { force_commit: true },
      permission_mode: "auto",
      overrides: {},
    });
    expect(forced.mode).toBe("confirm_before_execution");
    expect(forced.rule).toBe("computed_from_input");

    // The counter-proof matters as much as the guard: an ordinary save — a new
    // workflow, or an in-place update of the conversation's own bound draft —
    // carries neither argument and must stay frictionless. A gate that stops
    // everything is not an improvement.
    const ordinary = decideToolMode({
      tool: "save_workflow_draft",
      category: "tenant_write",
      input: { workflow_slug: "brand-new-thing" },
      permission_mode: "auto",
      overrides: {},
    });
    expect(ordinary.mode).toBe("no_confirm");

    // `yolo` is an explicitly armed, expiring, tenant-policy-gated override —
    // it keeps clearing this, exactly as it does for every other dangerous tool.
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
