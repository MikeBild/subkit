import { describe, expect, test } from "bun:test";
import { decideToolMode } from "../../conversations/tool-policies.ts";
import { getUnifiedRegistry } from "../../tools/index.ts";
import { policyDecide } from "../../tools/policy.ts";
import type { ToolCategory } from "../../tools/types.ts";
import { buildToolAnnotations, buildWorkflowToolAnnotations } from "../capabilities/tool-meta.ts";

const REPRESENTATIVE_INPUTS: ReadonlyArray<Record<string, unknown>> = [
  {},
  { environment: "prod" },
  { execute_writes: true },
  { method: "POST" },
  { method: "PATCH" },
  { method: "DELETE" },
  { method: "PUT" },
  { sql: "DELETE FROM t" },
  { sql: "SELECT 1", allow_writes: true },
  { body: { operation: "mutation", query: "mutation { x }" } },
];

function isConfirmCapable(tool: string, category: ToolCategory): boolean {
  return REPRESENTATIVE_INPUTS.some(
    (input) =>
      decideToolMode({
        tool,
        category,
        input,
        overrides: {},
        permission_mode: null,
      }).mode === "confirm_before_execution",
  );
}

describe("confirm-gate invariant — every MCP-reachable confirm-capable tool advertises destructiveHint:true", () => {
  test("registry sweep across product/authoring/admin modes", () => {
    const registry = getUnifiedRegistry();
    const seen = new Map<string, ToolCategory>();
    for (const mcpMode of ["product", "authoring", "admin"] as const) {
      for (const readOnly of [false, true]) {
        for (const d of registry.list({ surface: "mcp", mcpMode, readOnly })) {
          if (d.category === "draft_write") continue;
          seen.set(d.name, d.category);
        }
      }
    }

    expect(seen.size).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const [name, category] of seen) {
      if (!isConfirmCapable(name, category)) continue;
      for (const args of REPRESENTATIVE_INPUTS) {
        const mode = decideToolMode({
          tool: name,
          category,
          input: args,
          overrides: {},
          permission_mode: null,
        });
        if (mode.mode === "confirm_before_execution") {
          expect(policyDecide({ tool: name, category, surface: "mcp", args }).kind).toBe(
            "needs_confirm",
          );
        }
      }
      const annotations = buildToolAnnotations(category, name);
      if (annotations.destructiveHint !== true) {
        violations.push(
          `${name} (category=${category}) can resolve to confirm_before_execution but ` +
            `advertises destructiveHint:${String(annotations.destructiveHint)}`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  test("wf_<slug> workflow-run tools unconditionally advertise destructiveHint:true", () => {
    expect(buildWorkflowToolAnnotations().destructiveHint).toBe(true);
    expect(buildWorkflowToolAnnotations().readOnlyHint).toBe(false);
  });

  test("probe_connector and call_connector are confirm-capable and both advertise destructiveHint:true", () => {
    expect(isConfirmCapable("probe_connector", "tenant_read")).toBe(true);
    expect(isConfirmCapable("call_connector", "tenant_read")).toBe(true);
    expect(buildToolAnnotations("tenant_read", "probe_connector").destructiveHint).toBe(true);
    expect(buildToolAnnotations("tenant_read", "call_connector").destructiveHint).toBe(true);
  });
});
