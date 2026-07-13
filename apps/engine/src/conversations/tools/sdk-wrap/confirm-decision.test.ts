// Unit tests for the ONE confirm-gate decision (`decideConfirm`).
//
// This is the single deterministic rule every pre-execution gate
// evaluates. The security-critical invariant: a write NEVER proceeds
// without a durable `priorApproval`, and there is NO model-suppliable
// input that could stand in for one. The single exception is the
// enumerated MCP collapse: an MCP-origin turn was already human-gated by
// the client's destructiveHint dialog on the outer conversation_* call,
// so the enumerated additive/reversible tools proceed there — and ONLY
// there.

import { describe, expect, test } from "bun:test";
import { decideConfirm } from "./confirm-decision.ts";

describe("decideConfirm — reads auto-run", () => {
  test("tenant_read never pauses, regardless of mode", () => {
    for (const resolvedMode of [
      "no_confirm",
      "confirm_before_execution",
      "confirm_after_execution",
    ] as const) {
      const decision = decideConfirm({
        resolvedMode,
        priorApproval: false,
        category: "tenant_read",
        tool: "list_workflows",
      });
      expect(decision.pause).toBe(false);
      expect(decision.reason).toBe("tenant_read_autoruns");
    }
  });
});

describe("decideConfirm — non-confirm modes never pre-pause", () => {
  test("no_confirm write proceeds", () => {
    const decision = decideConfirm({
      resolvedMode: "no_confirm",
      priorApproval: false,
      category: "tenant_write",
      tool: "create_knowledge_source",
    });
    expect(decision.pause).toBe(false);
    expect(decision.reason).toBe("mode_not_confirm_before_execution");
  });

  test("confirm_after_execution does not PRE-pause (post-exec review is downstream)", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_after_execution",
      priorApproval: false,
      category: "tenant_write",
      tool: "authenticate_oauth",
    });
    expect(decision.pause).toBe(false);
    expect(decision.reason).toBe("mode_not_confirm_before_execution");
  });
});

describe("decideConfirm — writes under confirm_before_execution", () => {
  test("write WITHOUT a durable approval PAUSES", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      priorApproval: false,
      category: "tenant_write",
      tool: "delete_workflow",
    });
    expect(decision.pause).toBe(true);
    expect(decision.reason).toBe("confirm_required");
  });

  test("write WITH durable priorApproval proceeds", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      priorApproval: true,
      category: "tenant_write",
      tool: "save_workflow_draft",
    });
    expect(decision.pause).toBe(false);
    expect(decision.reason).toBe("prior_approval_present");
  });

  test("draft_write (save path) WITHOUT approval PAUSES — same rule as tenant_write", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      priorApproval: false,
      category: "draft_write",
      tool: "save_connector_draft",
    });
    expect(decision.pause).toBe(true);
    expect(decision.reason).toBe("confirm_required");
  });
});

describe("decideConfirm — enumerated MCP collapse", () => {
  test("mcp surface + collapsible tool proceeds with mcp_client_dialog_gate", () => {
    for (const tool of [
      "create_knowledge_source",
      "create_schedule",
      "create_skill",
      "save_workflow_draft",
    ]) {
      const decision = decideConfirm({
        resolvedMode: "confirm_before_execution",
        priorApproval: false,
        category: "tenant_write",
        tool,
        surface: "mcp",
        resolverRule: "category_default",
      });
      expect(decision.pause).toBe(false);
      expect(decision.reason).toBe("mcp_client_dialog_gate");
    }
  });

  test("mcp surface + NON-collapsible tool (delete_workflow) still PAUSES", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      priorApproval: false,
      category: "tenant_write",
      tool: "delete_workflow",
      surface: "mcp",
      resolverRule: "tool_default",
    });
    expect(decision.pause).toBe(true);
    expect(decision.reason).toBe("confirm_required");
  });

  test("mcp surface + inline_credential rule PAUSES even for a collapsible tool", () => {
    // The client dialog approved the TURN, not the staged secret — a
    // pasted credential must always surface one confirm step.
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      priorApproval: false,
      category: "tenant_write",
      tool: "create_knowledge_source",
      surface: "mcp",
      resolverRule: "inline_credential",
    });
    expect(decision.pause).toBe(true);
    expect(decision.reason).toBe("confirm_required");
  });

  test("security pin: mcp + run_workflow + computed_from_input PAUSES (live write / prod run)", () => {
    // run_workflow's ONLY confirm resolutions come from computeModeFromInput
    // (execute_writes:true, or a prod run) — the dangerous variants. The
    // collapse must never dispatch these unpaused: the outer client dialog
    // approved the turn, not a live write.
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      priorApproval: false,
      category: "tenant_write",
      tool: "run_workflow",
      surface: "mcp",
      resolverRule: "computed_from_input",
    });
    expect(decision.pause).toBe(true);
    expect(decision.reason).toBe("confirm_required");
  });

  test("mcp + collapsible tool with a NON-static resolver rule PAUSES", () => {
    // Only tool_default / category_default collapse — an explicit
    // conversation_override or permission_mode ask is honoured with a pause.
    for (const resolverRule of ["computed_from_input", "conversation_override"] as const) {
      const decision = decideConfirm({
        resolvedMode: "confirm_before_execution",
        priorApproval: false,
        category: "tenant_write",
        tool: "create_knowledge_source",
        surface: "mcp",
        resolverRule,
      });
      expect(decision.pause).toBe(true);
      expect(decision.reason).toBe("confirm_required");
    }
  });

  test("regression pin: chat surface pauses a collapsible tool", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      priorApproval: false,
      category: "tenant_write",
      tool: "create_knowledge_source",
      surface: "chat",
      resolverRule: "category_default",
    });
    expect(decision.pause).toBe(true);
    expect(decision.reason).toBe("confirm_required");
  });

  test("regression pin: absent surface pauses a collapsible tool", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      priorApproval: false,
      category: "tenant_write",
      tool: "create_knowledge_source",
      resolverRule: "category_default",
    });
    expect(decision.pause).toBe(true);
    expect(decision.reason).toBe("confirm_required");
  });

  test("regression pin: non-mcp surfaces all pause a collapsible tool", () => {
    for (const surface of ["sk_headless", "sk_interactive", "web", "chat"] as const) {
      const decision = decideConfirm({
        resolvedMode: "confirm_before_execution",
        priorApproval: false,
        category: "tenant_write",
        tool: "run_workflow",
        surface,
        resolverRule: "computed_from_input",
      });
      expect(decision.pause).toBe(true);
      expect(decision.reason).toBe("confirm_required");
    }
  });

  test("priorApproval branch is unchanged — it wins before the MCP collapse", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      priorApproval: true,
      category: "draft_write",
      tool: "save_workflow_draft",
      surface: "mcp",
      resolverRule: "tool_default",
    });
    expect(decision.pause).toBe(false);
    expect(decision.reason).toBe("prior_approval_present");
  });
});

describe("decideConfirm — bias to pause on ambiguity", () => {
  // The security property, stated exhaustively: across every input
  // combination, a write proceeds IFF a durable priorApproval exists,
  // and only under confirm_before_execution + a non-read category —
  // except the enumerated MCP collapse pinned above.
  test("no write proceeds under confirm_before_execution without a durable approval", () => {
    for (const category of ["tenant_write", "draft_write"] as const) {
      for (const priorApproval of [false, true]) {
        const decision = decideConfirm({
          resolvedMode: "confirm_before_execution",
          priorApproval,
          category,
          tool: "delete_workflow",
        });
        expect(decision.pause).toBe(!priorApproval);
      }
    }
  });
});
