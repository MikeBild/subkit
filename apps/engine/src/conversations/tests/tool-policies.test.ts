import { describe, expect, it } from "bun:test";
import type { ToolPolicies } from "../../tools/types.ts";
import {
  canSetConversationToolPolicy,
  decideToolMode,
  defaultModeForCategory,
  effectiveMode,
  eligibleNoConfirmTools,
  resolveToolMode,
} from "../tool-policies.ts";

describe("tool-policies resolver", () => {
  it("only exposes the two safe preparation saves for no-confirm conversation overrides", () => {
    expect(eligibleNoConfirmTools()).toEqual(["save_workflow_draft", "save_connector_draft"]);
    expect(canSetConversationToolPolicy("save_workflow_draft", "no_confirm")).toBe(true);
    expect(canSetConversationToolPolicy("call_connector", "no_confirm")).toBe(false);
    expect(canSetConversationToolPolicy("call_connector", "confirm_after_execution")).toBe(false);
    expect(canSetConversationToolPolicy("call_connector", "confirm_before_execution")).toBe(true);
  });
  it("defaults tenant_write to confirm_before_execution", () => {
    expect(defaultModeForCategory("tenant_write")).toBe("confirm_before_execution");
  });
  it("defaults read + draft to no_confirm", () => {
    expect(defaultModeForCategory("tenant_read")).toBe("no_confirm");
    expect(defaultModeForCategory("draft_write")).toBe("no_confirm");
  });
  it("only permitted per-conversation overrides win over the trusted default", () => {
    expect(
      effectiveMode(
        "save_workflow_draft",
        { save_workflow_draft: "no_confirm" },
        "confirm_before_execution",
      ),
    ).toBe("no_confirm");
    expect(
      effectiveMode("run_workflow", { run_workflow: "no_confirm" }, "confirm_before_execution"),
    ).toBe("confirm_before_execution");
  });
  it("falls back to default when no override", () => {
    const policies: ToolPolicies = {};
    expect(effectiveMode("list_workflows", policies, "no_confirm")).toBe("no_confirm");
  });
});

describe("resolveToolMode — dynamic TOOL_POLICIES", () => {
  it("legacy unsafe no-confirm overrides cannot bypass external writes or full responses", () => {
    expect(
      decideToolMode({
        tool: "call_connector",
        category: "tenant_read",
        input: { method: "POST" },
        overrides: { call_connector: "no_confirm" },
      }).mode,
    ).toBe("confirm_before_execution");
    expect(
      decideToolMode({
        tool: "call_connector",
        category: "tenant_read",
        input: { method: "GET", response_mode: "full" },
        overrides: { call_connector: "no_confirm" },
      }).mode,
    ).toBe("confirm_before_execution");
  });

  it("safe save overrides cannot bypass force or credentials", () => {
    expect(
      decideToolMode({
        tool: "save_workflow_draft",
        category: "draft_write",
        input: { force_commit: true },
        overrides: { save_workflow_draft: "no_confirm" },
      }).mode,
    ).toBe("confirm_before_execution");
    expect(
      decideToolMode({
        tool: "save_connector_draft",
        category: "draft_write",
        input: { credential: { mode: "api_key" } },
        overrides: { save_connector_draft: "no_confirm" },
      }).mode,
    ).toBe("confirm_before_execution");
    for (const ask_before_writing of [false, true]) {
      expect(
        decideToolMode({
          tool: "save_workflow_draft",
          category: "draft_write",
          input: { force_commit: true },
          overrides: { save_workflow_draft: "no_confirm" },
          ask_before_writing,
          connector_trust: true,
        }).mode,
      ).toBe("confirm_before_execution");
      expect(
        decideToolMode({
          tool: "save_connector_draft",
          category: "draft_write",
          input: { credential: { mode: "api_key" } },
          overrides: { save_connector_draft: "no_confirm" },
          ask_before_writing,
          connector_trust: true,
        }).mode,
      ).toBe("confirm_before_execution");
    }
  });
  it("development probes cannot disguise writes as automatic preparation", () => {
    for (const tool of ["probe_connector"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        for (const ask_before_writing of [false, true]) {
          expect(
            decideToolMode({
              tool,
              category: tool === "probe_connector" ? "tenant_read" : "draft_write",
              input: { environment: "dev", method },
              overrides: { [tool]: "no_confirm" },
              ask_before_writing,
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
        }).mode,
      ).toBe("no_confirm");
      expect(
        decideToolMode({
          tool,
          category: "tenant_read",
          input: { environment: "prod", method: "GET" },
          overrides: {},
        }).mode,
      ).toBe("no_confirm");
    }
  });

  it("draft probes with a write method require approval", () => {
    expect(
      decideToolMode({
        tool: "probe_connector_draft",
        category: "draft_write",
        input: { environment: "dev", method: "POST" },
        overrides: {},
      }).mode,
    ).toBe("confirm_before_execution");
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

  it("never-gate pins survive ask_before_writing", () => {
    for (const ask_before_writing of [false, true]) {
      for (const tool of ["load_skill", "save_learning"]) {
        const decision = decideToolMode({
          tool,
          category: "tenant_write",
          input: { slug: "workflow-authoring" },
          overrides: {},
          ask_before_writing,
        });
        expect(decision.mode).toBe("no_confirm");
        expect(decision.rule).toBe("never_gate");
      }
    }
  });

  it("an explicit per-conversation override still gates a never-gate tool", () => {
    const withAskBeforeWriting = decideToolMode({
      tool: "load_skill",
      category: "tenant_write",
      input: { slug: "workflow-authoring" },
      overrides: { load_skill: "confirm_before_execution" },
      ask_before_writing: true,
    });
    expect(withAskBeforeWriting.mode).toBe("confirm_before_execution");
    expect(withAskBeforeWriting.rule).not.toBe("never_gate");

    const withoutAskBeforeWriting = decideToolMode({
      tool: "load_skill",
      category: "tenant_write",
      input: { slug: "workflow-authoring" },
      overrides: { load_skill: "confirm_before_execution" },
    });
    expect(withoutAskBeforeWriting.mode).toBe("confirm_before_execution");
    expect(withoutAskBeforeWriting.rule).toBe("write_gate");
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
      });
      expect(decision.mode).toBe("no_confirm");
    }
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

  it("save_workflow_draft asks when the person asks before writing", () => {
    expect(
      resolveToolMode({
        tool: "save_workflow_draft",
        category: "draft_write",
        input: {},
        overrides: {},
        ask_before_writing: true,
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

  it("authenticate_oauth asks before it runs", () => {
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

describe("resolveToolMode — writes", () => {
  it("dangerous tools always ask", () => {
    expect(
      resolveToolMode({
        tool: "delete_connector",
        category: "tenant_write",
        input: { id: "00000000-0000-0000-0000-000000000000" },
        overrides: {},
      }),
    ).toBe("confirm_before_execution");
  });

  it("replacing a saved draft is inert; a forced save stays gated", () => {
    const overwrite = decideToolMode({
      tool: "save_workflow_draft",
      category: "tenant_write",
      input: { target_workflow_id: "5b873c3d-b9ce-465c-81a2-7a5a4e597365" },
      overrides: {},
    });
    expect(overwrite.mode).toBe("no_confirm");

    for (const ask_before_writing of [true])
      expect(
        decideToolMode({
          tool: "save_workflow_draft",
          category: "tenant_write",
          input: { target_workflow_id: "5b873c3d-b9ce-465c-81a2-7a5a4e597365" },
          ask_before_writing,
          overrides: {},
        }).mode,
      ).toBe("confirm_before_execution");

    const forcedReplacement = decideToolMode({
      tool: "save_workflow_draft",
      category: "tenant_write",
      input: { target_workflow_id: "5b873c3d-b9ce-465c-81a2-7a5a4e597365", force_commit: true },
      overrides: {},
    });
    expect(forcedReplacement.mode).toBe("confirm_before_execution");

    const forced = decideToolMode({
      tool: "save_workflow_draft",
      category: "tenant_write",
      input: { force_commit: true },
      overrides: {},
    });
    expect(forced.mode).toBe("confirm_before_execution");
    expect(forced.rule).toBe("computed_from_input");

    const ordinary = decideToolMode({
      tool: "save_workflow_draft",
      category: "tenant_write",
      input: { workflow_slug: "brand-new-thing" },
      overrides: {},
    });
    expect(ordinary.mode).toBe("no_confirm");
  });
});
