import { describe, expect, test } from "bun:test";
import { resolveToolMode } from "../../conversations/tool-policies.ts";
import type { ToolPolicies } from "../../tools/types.ts";

const EMPTY_OVERRIDES: ToolPolicies = {};

describe("policy-gate snapshot — resolveToolMode characterization", () => {
  test("test_connector tenant_read → no_confirm (any input)", () => {
    expect(
      resolveToolMode({
        tool: "test_connector",
        category: "tenant_read",
        input: { connector_id: "00000000-0000-0000-0000-000000000000" },
        overrides: EMPTY_OVERRIDES,
      }),
    ).toBe("no_confirm");
  });

  test("preview_attachment tenant_read → no_confirm", () => {
    expect(
      resolveToolMode({
        tool: "preview_attachment",
        category: "tenant_read",
        input: { slug: "demo.txt", max_chars: 8000 },
        overrides: EMPTY_OVERRIDES,
      }),
    ).toBe("no_confirm");
  });

  test("probe_connector dev GET → no_confirm", () => {
    expect(
      resolveToolMode({
        tool: "probe_connector",
        category: "tenant_read",
        input: {
          connector_slug: "demo",
          method: "GET",
          path: "/",
          environment: "dev",
        },
        overrides: EMPTY_OVERRIDES,
      }),
    ).toBe("no_confirm");
  });

  test("probe_connector prod POST → confirm_before_execution (computeModeFromInput escalation)", () => {
    expect(
      resolveToolMode({
        tool: "probe_connector",
        category: "tenant_read",
        input: {
          connector_slug: "demo",
          method: "POST",
          path: "/orders",
          environment: "prod",
          body: { foo: "bar" },
        },
        overrides: EMPTY_OVERRIDES,
      }),
    ).toBe("confirm_before_execution");
  });

  test("probe_connector dev POST → confirm_before_execution (development does not grant writes)", () => {
    expect(
      resolveToolMode({
        tool: "probe_connector",
        category: "tenant_read",
        input: {
          connector_slug: "demo",
          method: "POST",
          path: "/orders",
          environment: "dev",
          body: { foo: "bar" },
        },
        overrides: EMPTY_OVERRIDES,
      }),
    ).toBe("confirm_before_execution");
  });

  test("save_workflow_draft draft_write → confirm_before_execution when the person asks before writing", () => {
    expect(
      resolveToolMode({
        tool: "save_workflow_draft",
        category: "draft_write",
        input: { target_workflow_id: null, force_commit: false },
        overrides: EMPTY_OVERRIDES,
        ask_before_writing: true,
      }),
    ).toBe("confirm_before_execution");
  });

  test("dry_run_workflow draft_write → no_confirm (read-only preview)", () => {
    expect(
      resolveToolMode({
        tool: "dry_run_workflow",
        category: "draft_write",
        input: { environment: "dev" },
        overrides: EMPTY_OVERRIDES,
      }),
    ).toBe("no_confirm");
  });

  test("save_workflow_draft as a draft write → no_confirm", () => {
    expect(
      resolveToolMode({
        tool: "save_workflow_draft",
        category: "draft_write",
        input: {},
        overrides: EMPTY_OVERRIDES,
      }),
    ).toBe("no_confirm");
  });

  test("ask_before_writing + tenant_write → confirm_before_execution", () => {
    expect(
      resolveToolMode({
        tool: "save_workflow_draft",
        category: "tenant_write",
        input: {},
        overrides: EMPTY_OVERRIDES,
        ask_before_writing: true,
      }),
    ).toBe("confirm_before_execution");
  });

  test("per-tool overrides shadow the default mode", () => {
    expect(
      resolveToolMode({
        tool: "save_workflow_draft",
        category: "draft_write",
        input: {},
        overrides: { save_workflow_draft: "no_confirm" },
      }),
    ).toBe("no_confirm");
  });

  test("unknown tool tenant_read → no_confirm (category default, permissive)", () => {
    expect(
      resolveToolMode({
        tool: "imaginary_tool_xyz",
        category: "tenant_read",
        input: {},
        overrides: EMPTY_OVERRIDES,
      }),
    ).toBe("no_confirm");
  });

  test("unknown tool tenant_write → confirm_before_execution (category default IS confirm)", () => {
    expect(
      resolveToolMode({
        tool: "imaginary_tool_xyz",
        category: "tenant_write",
        input: {},
        overrides: EMPTY_OVERRIDES,
      }),
    ).toBe("confirm_before_execution");
  });
});
