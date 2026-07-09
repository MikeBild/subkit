// The safety invariant that makes the MCP confirm-collapse sound.
//
// `policyDecide` (tools/policy.ts) collapses `confirm_before_execution` to
// `proceed` for `surface:"mcp"` on the theory that the CLIENT's own
// `destructiveHint` dialog already gated the call before it reached the
// engine. That theory only holds if every tool the enforcement table
// (`decideToolMode` / `TOOL_POLICIES`, conversations/tool-policies.ts) can
// ever resolve to `confirm_before_execution` also advertises
// `destructiveHint:true` in `tools/list` (the annotation the client's dialog
// keys on).
//
// This test drives the REAL policy table with representative inputs (prod
// environment, `execute_writes:true`, a write-method `call_connector` call,
// mutating GraphQL/SQL bodies) against every tool the unified registry
// exposes over MCP, and asserts the annotation for every one that can ever
// resolve to `confirm_before_execution`. If a future tool becomes
// confirm-capable while staying advertised as read-only or non-destructive,
// this test fails BEFORE that hole ships — the client would never gate it,
// and MCP has no second, server-side confirm to fall back on.
//
// Exclusions:
//   - `draft_write` tools: blocked on MCP via `not_available_on_surface`
//     (tools/policy.ts) before the confirm gate is ever reached — they can
//     never actually execute on this surface, confirm-capable or not.
//   - tools not exposed over MCP at all (chat-only) — nothing to pin.

import { describe, expect, test } from "bun:test";
import { decideToolMode } from "../../conversations/tool-policies.ts";
import { getUnifiedRegistry } from "../../tools/index.ts";
import type { ToolCategory } from "../../tools/types.ts";
import { buildToolAnnotations, buildWorkflowToolAnnotations } from "../capabilities/tool-meta.ts";

/** Representative inputs, chosen to trip every `computeModeFromInput` /
 *  `computeDangerFromInput` branch in `TOOL_POLICIES` we know of today:
 *  a prod environment (run_workflow, dry_run_workflow, probe_connector,
 *  probe_connector_draft), an explicit live-write flag (run_workflow), and
 *  write-shaped `call_connector` payloads (HTTP method, SQL, GraphQL). Any
 *  input a tool doesn't recognize is simply inert for that tool. */
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

/** Does ANY representative input resolve this tool to
 *  `confirm_before_execution`, for the category the registry declared it
 *  under? Mirrors exactly what `policyDecide` feeds `decideToolMode`. */
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
          // draft_write never reaches the confirm gate on MCP — it is
          // rejected earlier with not_available_on_surface (tools/policy.ts).
          if (d.category === "draft_write") continue;
          seen.set(d.name, d.category);
        }
      }
    }

    expect(seen.size).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const [name, category] of seen) {
      if (!isConfirmCapable(name, category)) continue;
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

  // `wf_<slug>` workflow-run tools are not in the unified registry (they are
  // synthesized per-workflow, see mcp/capabilities/tools-helpers.ts) but are
  // squarely confirm-capable (a prod run gates via `run_workflow`'s own
  // policy entry, and every wf_ tool shares its confirm exposure). Their
  // annotation builder is unconditional, not input-dependent — pin it
  // directly rather than re-deriving a workflow DAG.
  test("wf_<slug> workflow-run tools unconditionally advertise destructiveHint:true", () => {
    expect(buildWorkflowToolAnnotations().destructiveHint).toBe(true);
    expect(buildWorkflowToolAnnotations().readOnlyHint).toBe(false);
  });

  // Regression pin for the two tools this collapse was built to cover:
  // probe_connector (prod POST) and call_connector (a write method). Naming
  // them explicitly means a future refactor of TOOL_POLICIES that
  // accidentally stops classifying either as confirm-capable is still
  // caught by the general sweep above, but a reviewer sees the concrete
  // case fail by name here.
  test("probe_connector and call_connector are confirm-capable and both advertise destructiveHint:true", () => {
    expect(isConfirmCapable("probe_connector", "tenant_read")).toBe(true);
    expect(isConfirmCapable("call_connector", "tenant_read")).toBe(true);
    expect(buildToolAnnotations("tenant_read", "probe_connector").destructiveHint).toBe(true);
    expect(buildToolAnnotations("tenant_read", "call_connector").destructiveHint).toBe(true);
  });
});
