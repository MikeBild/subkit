// Characterization snapshot — policy decision matrix.
//
// Pins the EXACT ExecutionMode that `resolveToolMode()` (the chat-side
// gate at conversations/tool-policies.ts:489) returns for a representative
// set of tools today. The unified `policyDecide()` is verified to
// unified function must reproduce the same answers for the same inputs;
// any drift fails this snapshot, which is what we want.
//
// The MCP-side gate (gateTenantToolCall) is a thin wrapper that consults
// resolveToolMode + isConfirmed; locking the chat resolver locks both
// surfaces.

import { describe, expect, test } from "bun:test";
import { resolveToolMode, type ToolPolicies } from "../../conversations/tool-policies.ts";

const EMPTY_OVERRIDES: ToolPolicies = {};

describe("policy-gate snapshot — resolveToolMode characterization", () => {
  // ---- tenant_read tools — must be no_confirm regardless of input ----

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

  // ---- probe_connector — escalates on prod + non-GET ----

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

  test("probe_connector dev POST → confirm_before_execution (mutating verb escalates regardless of env)", () => {
    // Surprised by this? The HTTP-verb gate fires on POST/PUT/PATCH/DELETE
    // even in dev. The prod-env gate adds an additional escalation source
    // (any non-GET on prod). Both paths converge on confirm_before_execution.
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

  // ---- draft_write tools — save_workflow_draft is the canonical destructive gate ----

  test("save_workflow_draft draft_write → confirm_before_execution (default)", () => {
    expect(
      resolveToolMode({
        tool: "save_workflow_draft",
        category: "draft_write",
        input: { target_workflow_id: null, force_commit: false },
        overrides: EMPTY_OVERRIDES,
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

  // ---- permission_mode overrides ----

  test("permission_mode=yolo → no_confirm for save_workflow_draft (escape hatch honored)", () => {
    expect(
      resolveToolMode({
        tool: "save_workflow_draft",
        category: "draft_write",
        input: {},
        overrides: EMPTY_OVERRIDES,
        permission_mode: "yolo",
      }),
    ).toBe("no_confirm");
  });

  test("permission_mode=ask + tenant_write → confirm_before_execution", () => {
    expect(
      resolveToolMode({
        tool: "save_workflow_draft",
        category: "tenant_write",
        input: {},
        overrides: EMPTY_OVERRIDES,
        permission_mode: "ask",
      }),
    ).toBe("confirm_before_execution");
  });

  // ---- per-tool overrides win over defaults ----

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

  // ---- unknown tool falls back to category default ----

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
    // Pins the actual category-default: tenant_write IS gated by default.
    // The policyDecide() extraction must preserve this so a new tenant_write
    // tool added without an explicit policy entry still demands confirm.
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
