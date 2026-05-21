// Unified policy-gate parity tests.
//
// policyDecide() must produce decisions structurally equivalent to:
//   resolveToolMode()  (chat surface, the current sdk-wrap path)
//   gateTenantToolCall() (MCP surface, current capabilities/policy-gate)
//
// We test the pure decision here. Audit emission happens in the
// dispatcher — those assertions live in dispatcher.test.ts.

import { describe, expect, test } from "bun:test";
import { resolveToolMode, type ToolPolicies } from "../../conversations/tool-policies.ts";
import { policyDecide } from "../policy.ts";

const EMPTY_OVERRIDES: ToolPolicies = {};

describe("tools/policy.policyDecide (active parity)", () => {
  test("tenant_read on chat → proceed", () => {
    expect(
      policyDecide({
        tool: "preview_attachment",
        category: "tenant_read",
        surface: "chat",
        args: { slug: "x" },
      }),
    ).toEqual({ kind: "proceed" });
  });

  test("tenant_read on mcp → proceed (no policy gate for reads, either surface)", () => {
    expect(
      policyDecide({
        tool: "preview_attachment",
        category: "tenant_read",
        surface: "mcp",
        args: { slug: "x" },
      }),
    ).toEqual({ kind: "proceed" });
  });

  test("draft_write on chat → proceed (current sdk-wrap behavior)", () => {
    // dry_run_workflow is draft_write but no_confirm — sdk-wrap dispatches.
    expect(
      policyDecide({
        tool: "dry_run_workflow",
        category: "draft_write",
        surface: "chat",
        args: {},
      }),
    ).toEqual({ kind: "proceed" });
  });

  test("draft_write on mcp → not_available_on_surface (honest reject)", () => {
    const decision = policyDecide({
      tool: "dry_run_workflow",
      category: "draft_write",
      surface: "mcp",
      args: {},
    });
    expect(decision.kind).toBe("not_available_on_surface");
    if (decision.kind === "not_available_on_surface") {
      // Structured, actionable message naming the entry tool — the
      // decision carries a sentence the client can surface verbatim
      // rather than a bare `requires_conversation_surface` code.
      expect(decision.reason).toContain("conversation_start");
      expect(decision.reason).toContain("MCP elicitation");
    }
  });

  test("save_workflow_draft chat (draft_write) without prior confirm → needs_confirm", () => {
    const decision = policyDecide({
      tool: "save_workflow_draft",
      category: "draft_write",
      surface: "chat",
      args: { force_commit: false },
    });
    expect(decision.kind).toBe("needs_confirm");
    if (decision.kind === "needs_confirm") {
      expect(decision.envelope.tool).toBe("save_workflow_draft");
      expect(decision.envelope.policy_mode).toBe("confirm_before_execution");
      expect(decision.envelope.tool_call_id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  test("save_workflow_draft on chat WITH __policy_confirmed=true → proceed (confirmed)", () => {
    expect(
      policyDecide({
        tool: "save_workflow_draft",
        category: "draft_write",
        surface: "chat",
        args: { __policy_confirmed: true, force_commit: false },
      }),
    ).toEqual({ kind: "proceed" });
  });

  test("MCP tenant_write WITH _meta.sk_confirm=true → proceed", () => {
    expect(
      policyDecide({
        tool: "imaginary_tenant_write_tool",
        category: "tenant_write",
        surface: "mcp",
        args: {},
        meta: { sk_confirm: true },
      }),
    ).toEqual({ kind: "proceed" });
  });

  test("MCP tenant_write without confirm → needs_confirm with MCP-shaped resume hint", () => {
    const decision = policyDecide({
      tool: "imaginary_tenant_write_tool",
      category: "tenant_write",
      surface: "mcp",
      args: {},
    });
    expect(decision.kind).toBe("needs_confirm");
    if (decision.kind === "needs_confirm") {
      expect(decision.envelope.resume).toContain("sk_confirm=true");
    }
  });

  test("chat tenant_write without confirm → needs_confirm with chat-shaped resume hint", () => {
    const decision = policyDecide({
      tool: "imaginary_tenant_write_tool",
      category: "tenant_write",
      surface: "chat",
      args: {},
    });
    expect(decision.kind).toBe("needs_confirm");
    if (decision.kind === "needs_confirm") {
      expect(decision.envelope.resume).toContain("ask_user_confirm");
    }
  });

  test("permission_mode=yolo → proceed for save_workflow_draft (escape hatch honored)", () => {
    expect(
      policyDecide({
        tool: "save_workflow_draft",
        category: "draft_write",
        surface: "chat",
        args: {},
        permission_mode: "yolo",
      }),
    ).toEqual({ kind: "proceed" });
  });

  // ---- Property-style parity sweep against resolveToolMode ----
  test("chat-surface decision mirrors resolveToolMode for representative tools", () => {
    const cases = [
      { tool: "test_connector", category: "tenant_read" as const, args: { connector_id: "x" } },
      {
        tool: "probe_connector",
        category: "tenant_read" as const,
        args: {
          connector_slug: "x",
          method: "POST" as const,
          environment: "prod" as const,
          path: "/",
        },
      },
      { tool: "save_workflow_draft", category: "draft_write" as const, args: {} },
      { tool: "dry_run_workflow", category: "draft_write" as const, args: {} },
    ];
    for (const c of cases) {
      const mode = resolveToolMode({
        tool: c.tool,
        category: c.category,
        input: c.args,
        overrides: EMPTY_OVERRIDES,
      });
      const expectedProceed = mode !== "confirm_before_execution";
      const decision = policyDecide({
        tool: c.tool,
        category: c.category,
        surface: "chat",
        args: c.args,
      });
      if (expectedProceed) {
        expect(decision.kind).toBe("proceed");
      } else {
        expect(decision.kind).toBe("needs_confirm");
      }
    }
  });

  // Regression unit test for the legacy MCP `tenant_read` shortcut
  // bug: the old gateTenantToolCall in mcp/capabilities/policy-gate.ts
  // short-circuited every `tenant_read` past `computeModeFromInput`,
  // so probe_connector POST against prod silently executed without
  // confirmation on MCP while chat correctly gated. The unified
  // policyDecide() removes the shortcut. probe-connector-prod-confirm
  // covers this end-to-end via the live MCP transport; this unit test
  // pins the same regression at the policy-decision layer so a future
  // resolveToolMode refactor can't regress without a unit signal.
  test("regression — probe_connector POST against prod gates on BOTH surfaces", () => {
    const args = {
      connector_slug: "demo",
      method: "POST" as const,
      path: "/orders",
      environment: "prod" as const,
      body: { foo: "bar" },
    };
    const chat = policyDecide({
      tool: "probe_connector",
      category: "tenant_read",
      surface: "chat",
      args,
    });
    const mcp = policyDecide({
      tool: "probe_connector",
      category: "tenant_read",
      surface: "mcp",
      args,
    });
    expect(chat.kind).toBe("needs_confirm");
    expect(mcp.kind).toBe("needs_confirm");
  });
});
