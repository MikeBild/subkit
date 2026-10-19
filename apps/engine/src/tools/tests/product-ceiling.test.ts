import { describe, expect, test } from "bun:test";
import { PRODUCT_PERMISSIONS } from "../../rbac/evaluator.ts";
import { dispatchTool } from "../dispatcher.ts";
import { getUnifiedRegistry } from "../index.ts";
import type { ToolDescriptor } from "../types.ts";
import { makeStubDb, makeTestPrincipal, usePolicyFixture } from "./_helpers.ts";

usePolicyFixture();

const MODES = ["product", "authoring", "admin"] as const;

function mcpReachableTools(): Array<{
  descriptor: ToolDescriptor;
  mcpMode: (typeof MODES)[number];
}> {
  const registry = getUnifiedRegistry();
  const seen = new Map<string, { descriptor: ToolDescriptor; mcpMode: (typeof MODES)[number] }>();
  for (const mcpMode of MODES) {
    for (const readOnly of [false, true]) {
      for (const descriptor of registry.list({ surface: "mcp", mcpMode, readOnly })) {
        if (!seen.has(descriptor.name)) seen.set(descriptor.name, { descriptor, mcpMode });
      }
    }
  }
  return [...seen.values()];
}

describe("product principals and the tool dispatcher", () => {
  test("every MCP tool outside the product permissions answers policy_denied", async () => {
    const tools = mcpReachableTools().filter(
      ({ descriptor }) => !PRODUCT_PERMISSIONS.has(descriptor.rbac?.permission ?? ""),
    );
    expect(tools.map(({ descriptor }) => descriptor.name)).toEqual(
      expect.arrayContaining([
        "list_workflows",
        "find_workflow",
        "find_user",
        "find_role",
        "list_roles",
        "whoami",
        "get_engine_status",
        "list_inbound_hooks",
        "list_subscriptions",
        "list_patch_candidates",
        "list_skill_candidates",
      ]),
    );
    const principal = makeTestPrincipal({ product_id: "app", roles: ["member"] });
    for (const { descriptor, mcpMode } of tools) {
      const { db, capture } = makeStubDb();
      const envelope = await dispatchTool(
        { registry: getUnifiedRegistry(), db, principal, mcpMode, readOnly: false },
        { surface: "mcp", name: descriptor.name, args: {} },
      );
      expect({ tool: descriptor.name, envelope }).toMatchObject({
        tool: descriptor.name,
        envelope: { status: "error", error_code: "policy_denied" },
      });
      expect(capture.inserts.some((row) => row.action === "policy.denied")).toBe(true);
    }
  });
});
