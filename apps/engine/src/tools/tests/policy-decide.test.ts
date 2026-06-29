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
import {
  DRAFT_WRITE_MCP_UNAVAILABLE_REASON,
  MCP_ELICITATION_BLURB,
  policyDecide,
} from "../policy.ts";

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
      expect(decision.reason).toBe(DRAFT_WRITE_MCP_UNAVAILABLE_REASON);
    }
  });

  // Lock-step protection: `DRAFT_WRITE_MCP_UNAVAILABLE_REASON` is built
  // by interpolating `MCP_ELICITATION_BLURB`, and the same blurb is woven
  // into the `conversation_start` / `conversation_append` tool
  // descriptions. Pinning the containment here means a future wording
  // change to the blurb cannot silently desync the constant from its
  // consumers — the assertion fails before the desync ships.
  test("DRAFT_WRITE_MCP_UNAVAILABLE_REASON embeds MCP_ELICITATION_BLURB verbatim", () => {
    expect(DRAFT_WRITE_MCP_UNAVAILABLE_REASON.includes(MCP_ELICITATION_BLURB)).toBe(true);
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
      // MCP clients resolve the gate in-band via elicitation, or via the
      // confirm_tool_call fallback — never by setting transport `_meta`
      // (a model-only client cannot).
      expect(decision.envelope.resume).toContain("confirm_tool_call");
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

// call_connector is category tenant_read but issues arbitrary side
// effects. The prod incident: a direct PATCH to a Notion endpoint over
// MCP executed with NO confirm gate, because call_connector was absent
// from TOOL_POLICIES and fell back to the tenant_read default
// (no_confirm). These pin the fix: gate on the ACTUAL side effect, on
// both surfaces, and don't let permission_mode=auto auto-approve a write.
describe("tools/policy.policyDecide — call_connector gates on real side effect", () => {
  const read = (extra: Record<string, unknown>) => ({ connector_id: "c", ...extra });

  test("GET reads proceed on BOTH surfaces", () => {
    for (const surface of ["chat", "mcp"] as const) {
      expect(
        policyDecide({
          tool: "call_connector",
          category: "tenant_read",
          surface,
          args: read({ method: "GET", path: "/x" }),
        }),
      ).toEqual({ kind: "proceed" });
    }
  });

  test("regression — POST/PATCH/DELETE writes confirm on BOTH surfaces", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      for (const surface of ["chat", "mcp"] as const) {
        const decision = policyDecide({
          tool: "call_connector",
          category: "tenant_read",
          surface,
          args: read({ method, path: "/x" }),
        });
        expect(decision.kind).toBe("needs_confirm");
        if (decision.kind === "needs_confirm") {
          expect(decision.envelope.reason).toBe("destructive_action");
        }
      }
    }
  });

  test("postgres SELECT proceeds, non-SELECT / allow_writes confirms", () => {
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "mcp",
        args: read({ sql: "SELECT 1" }),
      }),
    ).toEqual({ kind: "proceed" });
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "mcp",
        args: read({ sql: "DELETE FROM t" }),
      }).kind,
    ).toBe("needs_confirm");
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "mcp",
        args: read({ sql: "SELECT 1", allow_writes: true }),
      }).kind,
    ).toBe("needs_confirm");
  });

  test("graphql query proceeds, mutation confirms", () => {
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "mcp",
        args: read({ body: { query: "query { me }" } }),
      }),
    ).toEqual({ kind: "proceed" });
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "mcp",
        args: read({ body: { operation: "mutation", query: "mutation { x }" } }),
      }).kind,
    ).toBe("needs_confirm");
  });

  test("S3 LIST is a read (proceeds); PUT confirms", () => {
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "mcp",
        args: read({ method: "LIST", path: "/" }),
      }),
    ).toEqual({ kind: "proceed" });
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "mcp",
        args: read({ method: "PUT", path: "/k" }),
      }).kind,
    ).toBe("needs_confirm");
  });

  test("a write still confirms under permission_mode=auto (ordering fix)", () => {
    const decision = policyDecide({
      tool: "call_connector",
      category: "tenant_read",
      surface: "chat",
      args: read({ method: "PATCH", path: "/x" }),
      permission_mode: "auto",
    });
    expect(decision.kind).toBe("needs_confirm");
  });

  test("a read auto-runs under permission_mode=auto", () => {
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "chat",
        args: read({ method: "GET", path: "/x" }),
        permission_mode: "auto",
      }),
    ).toEqual({ kind: "proceed" });
  });

  test("yolo honours the user's armed override even for a write", () => {
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "chat",
        args: read({ method: "DELETE", path: "/x" }),
        permission_mode: "yolo",
      }),
    ).toEqual({ kind: "proceed" });
  });
});
