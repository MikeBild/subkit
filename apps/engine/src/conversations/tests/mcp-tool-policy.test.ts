import { describe, expect, it } from "bun:test";
import { isDangerousTool } from "../dangerous-tools.ts";
import { decideToolMode, getApprovalMode, resolveToolMode } from "../tool-policies.ts";

const FAKE_MCP_TOOL = "mcp_examplemcp__create_page";
const FAKE_MCP_TOOL_2 = "mcp_acme__search_items";

describe("isDangerousTool — mcp_ prefix", () => {
  it("mcp_<ns>__<tool> is dangerous", () => {
    expect(isDangerousTool(FAKE_MCP_TOOL)).toBe(true);
  });

  it("mcp_ with deep namespace is dangerous", () => {
    expect(isDangerousTool(FAKE_MCP_TOOL_2)).toBe(true);
  });

  it("non-mcp tools that are not on the list are NOT dangerous", () => {
    expect(isDangerousTool("list_workflows")).toBe(false);
    expect(isDangerousTool("edit_workflow_patch")).toBe(false);
  });
});

describe("resolveToolMode — mcp_ tools under auto mode", () => {
  it("auto mode: mcp tool still requires confirm_before_execution (dangerous gate)", () => {
    const mode = resolveToolMode({
      tool: FAKE_MCP_TOOL,
      category: "tenant_write",
      input: {},
      overrides: {},
      permission_mode: "auto",
    });
    expect(mode).toBe("confirm_before_execution");
  });

  it("auto mode: second mcp tool namespace also gated", () => {
    const mode = resolveToolMode({
      tool: FAKE_MCP_TOOL_2,
      category: "tenant_write",
      input: {},
      overrides: {},
      permission_mode: "auto",
    });
    expect(mode).toBe("confirm_before_execution");
  });
});

describe("resolveToolMode — mcp_ tools under ask mode", () => {
  it("ask mode: mcp tool resolves to confirm_before_execution", () => {
    const mode = resolveToolMode({
      tool: FAKE_MCP_TOOL,
      category: "tenant_write",
      input: {},
      overrides: {},
      permission_mode: "ask",
    });
    expect(mode).toBe("confirm_before_execution");
  });
});

describe("resolveToolMode — mcp_ tools under plan mode", () => {
  it("plan mode: mcp tool resolves to confirm_before_execution", () => {
    const mode = resolveToolMode({
      tool: FAKE_MCP_TOOL,
      category: "tenant_write",
      input: {},
      overrides: {},
      permission_mode: "plan",
    });
    expect(mode).toBe("confirm_before_execution");
  });
});

describe("resolveToolMode — mcp_ tools under yolo mode", () => {
  it("yolo bypasses the dangerous-tool gate for mcp_ tools", () => {
    const mode = resolveToolMode({
      tool: FAKE_MCP_TOOL,
      category: "tenant_write",
      input: {},
      overrides: {},
      permission_mode: "yolo",
    });
    expect(mode).toBe("no_confirm");
  });

  it("yolo also lifts the gate for a second mcp namespace", () => {
    const mode = resolveToolMode({
      tool: FAKE_MCP_TOOL_2,
      category: "tenant_write",
      input: {},
      overrides: {},
      permission_mode: "yolo",
    });
    expect(mode).toBe("no_confirm");
  });
});

describe("resolveToolMode — mcp_ tool with no permission_mode (default path)", () => {
  it("no permission_mode: falls through to category default = confirm_before_execution", () => {
    const mode = resolveToolMode({
      tool: FAKE_MCP_TOOL,
      category: "tenant_write",
      input: {},
      overrides: {},
    });
    expect(mode).toBe("confirm_before_execution");
  });
});

describe("resolveToolMode — per-conversation overrides and the external-MCP dispatch path", () => {
  const storedNoConfirmOverride = { [FAKE_MCP_TOOL]: "no_confirm" as const };

  it("loop path: a stored no_confirm preference cannot grant external authority under auto", () => {
    const mode = resolveToolMode({
      tool: FAKE_MCP_TOOL,
      category: "tenant_write",
      input: {},
      overrides: storedNoConfirmOverride,
      permission_mode: "auto",
    });
    expect(mode).toBe("confirm_before_execution");
  });

  it("external-MCP dispatch path: the same stored override cannot apply — empty overrides keep confirm_before_execution", () => {
    const mode = resolveToolMode({
      tool: FAKE_MCP_TOOL,
      category: "tenant_write",
      input: {},
      overrides: {},
    });
    expect(mode).toBe("confirm_before_execution");
  });
});

describe("getApprovalMode — mcp_ prefix", () => {
  it("getApprovalMode returns approval_before for mcp_ tools", () => {
    expect(getApprovalMode(FAKE_MCP_TOOL)).toBe("approval_before");
    expect(getApprovalMode(FAKE_MCP_TOOL_2)).toBe("approval_before");
  });

  it("getApprovalMode uses mcp_ prefix check, not TOOL_POLICIES lookup", () => {
    expect(getApprovalMode("mcp_anynamespace__any_tool")).toBe("approval_before");
  });

  it("getApprovalMode returns auto for unknown non-mcp tools (regression guard)", () => {
    expect(getApprovalMode("unknown_tool_xyz")).toBe("auto");
  });
});

describe("decideToolMode — operator trust (connector_trust)", () => {
  it("a trusted mcp tool runs without confirmation, and the rule is named", () => {
    expect(
      decideToolMode({
        tool: FAKE_MCP_TOOL,
        category: "tenant_write",
        input: {},
        overrides: {},
        connector_trust: true,
      }),
    ).toEqual({ mode: "no_confirm", rule: "connector_trust" });
  });

  it("permission_mode plan outranks operator trust", () => {
    expect(
      decideToolMode({
        tool: FAKE_MCP_TOOL,
        category: "tenant_write",
        input: {},
        overrides: {},
        permission_mode: "plan",
        connector_trust: true,
      }),
    ).toEqual({ mode: "confirm_before_execution", rule: "permission_mode" });
  });

  it("the inline-credential safeguard outranks operator trust", () => {
    expect(
      decideToolMode({
        tool: "update_connector_draft",
        category: "draft_write",
        input: { config: { api_key: "sk-inline" } },
        overrides: {},
        connector_trust: true,
      }),
    ).toEqual({ mode: "confirm_before_execution", rule: "inline_credential" });
  });

  it("without trust an mcp tool keeps confirming", () => {
    expect(
      decideToolMode({ tool: FAKE_MCP_TOOL, category: "tenant_write", input: {}, overrides: {} })
        .mode,
    ).toBe("confirm_before_execution");
  });
});
