import { describe, expect, test } from "bun:test";
import {
  buildPendingOutputForTool,
  resolveToolMode,
  type ToolPolicies,
} from "../../conversations/tool-policies.ts";
import {
  confirmEnvelopeFor,
  DRAFT_WRITE_MCP_UNAVAILABLE_REASON,
  MCP_ELICITATION_BLURB,
  policyDecide,
} from "../policy.ts";

const EMPTY_OVERRIDES: ToolPolicies = {};
const APPROVAL_ID = "00000000-0000-4000-8000-00000000a11d";

describe("tools/policy.policyDecide (active parity)", () => {
  test("tenant_read on chat → proceed", () => {
    expect(
      policyDecide({
        tool: "preview_attachment",
        category: "tenant_read",
        surface: "chat",
        args: { slug: "x" },
      }),
    ).toEqual({
      kind: "proceed",
      mode: "no_confirm",
      rule: "category_default",
      skip_reason: "mode_not_confirm_before_execution",
    });
  });

  test("tenant_read on mcp → proceed (no policy gate for reads, either surface)", () => {
    expect(
      policyDecide({
        tool: "preview_attachment",
        category: "tenant_read",
        surface: "mcp",
        args: { slug: "x" },
      }),
    ).toMatchObject({ kind: "proceed", mode: "no_confirm", rule: "category_default" });
  });

  test("draft_write on chat → proceed (current sdk-wrap behavior)", () => {
    expect(
      policyDecide({
        tool: "dry_run_workflow",
        category: "draft_write",
        surface: "chat",
        args: {},
      }),
    ).toMatchObject({ kind: "proceed", mode: "no_confirm", rule: "computed_from_input" });
  });

  test("draft_write on mcp → not_available_on_surface (honest reject) still names mode and rule", () => {
    const decision = policyDecide({
      tool: "dry_run_workflow",
      category: "draft_write",
      surface: "mcp",
      args: {},
    });
    expect(decision).toEqual({
      kind: "not_available_on_surface",
      mode: "no_confirm",
      rule: "computed_from_input",
      reason: DRAFT_WRITE_MCP_UNAVAILABLE_REASON,
    });
  });

  test("DRAFT_WRITE_MCP_UNAVAILABLE_REASON embeds MCP_ELICITATION_BLURB verbatim", () => {
    expect(DRAFT_WRITE_MCP_UNAVAILABLE_REASON.includes(MCP_ELICITATION_BLURB)).toBe(true);
  });

  test("save_workflow_draft chat (draft_write) without prior confirm → needs_confirm", () => {
    expect(
      policyDecide({
        tool: "save_workflow_draft",
        category: "draft_write",
        surface: "chat",
        args: { force_commit: false },
      }),
    ).toEqual({ kind: "needs_confirm", mode: "confirm_before_execution", rule: "tool_default" });
  });

  test("a prior approval within its window skips the pause and says why", () => {
    expect(
      policyDecide({
        tool: "save_workflow_draft",
        category: "draft_write",
        surface: "chat",
        args: { force_commit: false },
        prior_approval: true,
      }),
    ).toEqual({
      kind: "proceed",
      mode: "confirm_before_execution",
      rule: "tool_default",
      skip_reason: "prior_approval_present",
    });
  });

  test("a prior approval never widens a no_confirm decision's skip reason", () => {
    expect(
      policyDecide({
        tool: "preview_attachment",
        category: "tenant_read",
        surface: "chat",
        args: {},
        prior_approval: true,
      }),
    ).toMatchObject({ kind: "proceed", skip_reason: "mode_not_confirm_before_execution" });
  });

  test("save_workflow_draft on chat WITH __policy_confirmed=true → proceed (confirmed)", () => {
    expect(
      policyDecide({
        tool: "save_workflow_draft",
        category: "draft_write",
        surface: "chat",
        args: { __policy_confirmed: true, force_commit: false },
      }),
    ).toEqual({
      kind: "proceed",
      mode: "confirm_before_execution",
      rule: "tool_default",
      skip_reason: "confirmed_marker",
    });
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
    ).toEqual({
      kind: "proceed",
      mode: "confirm_before_execution",
      rule: "category_default",
      skip_reason: "confirmed_marker",
    });
  });

  test("MCP tenant_write without a local approval requires confirmation", () => {
    expect(
      policyDecide({
        tool: "imaginary_tenant_write_tool",
        category: "tenant_write",
        surface: "mcp",
        args: {},
      }),
    ).toEqual({
      kind: "needs_confirm",
      mode: "confirm_before_execution",
      rule: "category_default",
    });
  });

  test("a destructive operation requires confirmation on both surfaces", () => {
    const args = {
      connector_id: "c",
      method: "DELETE" as const,
      path: "/x",
    };
    const chat = policyDecide({
      tool: "call_connector",
      category: "tenant_read",
      surface: "chat",
      args,
    });
    const mcp = policyDecide({
      tool: "call_connector",
      category: "tenant_read",
      surface: "mcp",
      args,
    });
    expect(chat.kind).toBe("needs_confirm");
    expect(mcp.kind).toBe("needs_confirm");
    if (mcp.kind === "needs_confirm") {
      expect(
        confirmEnvelopeFor({
          tool: "call_connector",
          pending_output: buildPendingOutputForTool("call_connector", args),
          rule: mcp.rule,
          approval_id: APPROVAL_ID,
          approval_url: null,
          surface: "mcp",
        }).resume,
      ).toContain("confirm_tool_call");
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
      expect(
        confirmEnvelopeFor({
          tool: "imaginary_tenant_write_tool",
          pending_output: null,
          rule: decision.rule,
          approval_id: APPROVAL_ID,
          approval_url: null,
          surface: "chat",
        }).resume,
      ).toContain("ask_user_confirm");
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
    ).toEqual({
      kind: "proceed",
      mode: "no_confirm",
      rule: "permission_mode",
      skip_reason: "mode_not_confirm_before_execution",
    });
  });

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
      expect(decision.mode).toBe(mode);
      if (expectedProceed) {
        expect(decision.kind).toBe("proceed");
      } else {
        expect(decision.kind).toBe("needs_confirm");
      }
    }
  });

  test("probe_connector POST against prod requires local approval on chat and MCP", () => {
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

describe("tools/policy.confirmEnvelopeFor", () => {
  test("the envelope carries the approval id as tool_call_id, the approval url and the pending output", () => {
    const args = { workflow: "nightly", environment: "prod", input: { a: 1, b: 2 } };
    const envelope = confirmEnvelopeFor({
      tool: "run_workflow",
      pending_output: buildPendingOutputForTool("run_workflow", args),
      rule: "conversation_override",
      approval_id: APPROVAL_ID,
      approval_url: "https://engine.example.test/v1/tool-approvals/decide?grant=skag_x",
      surface: "mcp",
    });
    expect(envelope).toEqual({
      tool: "run_workflow",
      pending_output: {
        workflow: "nightly",
        version_id: null,
        environment: "prod",
        input_keys: ["a", "b"],
      },
      policy_mode: "confirm_before_execution",
      reason: "conversation_override",
      tool_call_id: APPROVAL_ID,
      approval_url: "https://engine.example.test/v1/tool-approvals/decide?grant=skag_x",
      resume: envelope.resume,
    });
    expect(envelope.resume).toContain("confirm_tool_call");
  });

  test("a chat envelope points at ask_user_confirm and keeps a missing portal link as null", () => {
    const envelope = confirmEnvelopeFor({
      tool: "imaginary_tenant_write_tool",
      pending_output: null,
      rule: "category_default",
      approval_id: APPROVAL_ID,
      approval_url: null,
      surface: "chat",
    });
    expect(envelope.approval_url).toBeNull();
    expect(envelope.pending_output).toBeNull();
    expect(envelope.resume).toContain("ask_user_confirm");
  });
});

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
      ).toMatchObject({ kind: "proceed", mode: "no_confirm", rule: "computed_from_input" });
    }
  });

  test("POST/PATCH/PUT/DELETE writes confirm on chat and MCP", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(
        policyDecide({
          tool: "call_connector",
          category: "tenant_read",
          surface: "chat",
          args: read({ method, path: "/x" }),
        }),
      ).toEqual({
        kind: "needs_confirm",
        mode: "confirm_before_execution",
        rule: "computed_from_input",
      });
      expect(
        policyDecide({
          tool: "call_connector",
          category: "tenant_read",
          surface: "mcp",
          args: read({ method, path: "/x" }),
        }).kind,
      ).toBe("needs_confirm");
    }
  });

  test("postgres SELECT proceeds; non-SELECT / allow_writes confirms on both surfaces", () => {
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "chat",
        args: read({ sql: "SELECT 1" }),
      }).kind,
    ).toBe("proceed");
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "chat",
        args: read({ sql: "DELETE FROM t" }),
      }).kind,
    ).toBe("needs_confirm");
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "chat",
        args: read({ sql: "SELECT 1", allow_writes: true }),
      }).kind,
    ).toBe("needs_confirm");
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "mcp",
        args: read({ sql: "DELETE FROM t" }),
      }).kind,
    ).toBe("needs_confirm");
  });

  test("graphql query proceeds; mutation confirms on both surfaces", () => {
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "chat",
        args: read({ body: { query: "query { me }" } }),
      }).kind,
    ).toBe("proceed");
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "chat",
        args: read({ body: { operation: "mutation", query: "mutation { x }" } }),
      }).kind,
    ).toBe("needs_confirm");
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "mcp",
        args: read({ body: { operation: "mutation", query: "mutation { x }" } }),
      }).kind,
    ).toBe("needs_confirm");
  });

  test("S3 LIST proceeds; PUT confirms on both surfaces", () => {
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "chat",
        args: read({ method: "LIST", path: "/" }),
      }).kind,
    ).toBe("proceed");
    expect(
      policyDecide({
        tool: "call_connector",
        category: "tenant_read",
        surface: "chat",
        args: read({ method: "PUT", path: "/k" }),
      }).kind,
    ).toBe("needs_confirm");
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
      }).kind,
    ).toBe("proceed");
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
    ).toMatchObject({ kind: "proceed", mode: "no_confirm", rule: "permission_mode" });
  });
});
