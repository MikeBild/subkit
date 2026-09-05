// Policy resolver coverage for external MCP tools (`mcp_<ns>__<tool>`).
//
// External MCP tools are treated as dangerous (they leave
// the tenant perimeter to a third-party server) so they MUST resolve to
// `confirm_before_execution` under all non-yolo permission modes. Only
// `yolo` lifts the gate (consistent with other dangerous tools like
// delete_workflow).
//
// Uses GENERIC fake namespace "examplemcp" — no real vendor names.

import { describe, expect, it } from "bun:test";
import { isDangerousTool } from "../dangerous-tools.ts";
import { getApprovalMode, resolveToolMode } from "../tool-policies.ts";

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
    // auto short-circuits non-dangerous; mcp_ IS dangerous so must not bypass.
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
  // The chat palette's external-MCP dispatch resolves policy through
  // `policyDecide` (tools/policy.ts), which hands `resolveToolMode` EMPTY
  // overrides and no permission_mode —
  // exactly the arguments pinned below. A stored per-conversation
  // `no_confirm` override therefore never lifts the confirm gate on that
  // path. Bounded auto also refuses that override on the loop path: neither
  // a tool preference nor a transport difference grants external authority.
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
    // The external-MCP dispatch passes `overrides: {}` and no permission_mode
    // for `mcp_<ns>__<tool>` calls; the stored override above is unreachable.
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
    // This tool is not in TOOL_POLICIES; the mcp_ prefix guard must fire first.
    expect(getApprovalMode("mcp_anynamespace__any_tool")).toBe("approval_before");
  });

  it("getApprovalMode returns auto for unknown non-mcp tools (regression guard)", () => {
    expect(getApprovalMode("unknown_tool_xyz")).toBe("auto");
  });
});
