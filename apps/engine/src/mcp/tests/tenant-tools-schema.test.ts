// MCP tenant tool exposure — input-schema conversion is real.
// Regression test for the audit finding that zodToMcpSchema shipped
// bare {type:"object", properties:{}} for every tenant_* tool. After
// Gap #P0, Zod v4's native `z.toJSONSchema` is called for all tools
// and most generated tools now have populated `properties`.

import { describe, expect, it } from "bun:test";
import { listTenantTools } from "../capabilities/tenant-tools.ts";

describe("MCP tenant tool exposure", () => {
  it("publishes read tools with non-empty property schemas", () => {
    const tools = listTenantTools({ allowWrites: false });
    expect(tools.length).toBeGreaterThan(5);

    const getWorkflow = tools.find((t) => t.name === "tenant_get_workflow");
    expect(getWorkflow).toBeDefined();
    const schema = getWorkflow?.inputSchema as {
      type: string;
      properties?: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    // `get_workflow` takes either id or slug — both should appear in
    // the converted JSON Schema. If the conversion regressed to the
    // empty-properties fallback, this assertion fails.
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(["id", "slug"]));
  });

  it("hides draft_write tools from MCP", () => {
    const tools = listTenantTools({ allowWrites: false });
    expect(tools.map((t) => t.name)).not.toContain("tenant_propose_step");
    expect(tools.map((t) => t.name)).not.toContain("tenant_save_workflow_draft");
  });

  it("hides tenant_write tools when allowWrites=false", () => {
    const tools = listTenantTools({ allowWrites: false });
    expect(tools.map((t) => t.name)).not.toContain("tenant_run_workflow");
    expect(tools.map((t) => t.name)).not.toContain("tenant_approve_patch_candidate");
    expect(tools.map((t) => t.name)).not.toContain("tenant_delete_workflow");
  });

  it("exposes tenant_write tools when allowWrites=true", () => {
    const tools = listTenantTools({ allowWrites: true });
    expect(tools.map((t) => t.name)).toContain("tenant_run_workflow");
    expect(tools.map((t) => t.name)).toContain("tenant_approve_patch_candidate");
    expect(tools.map((t) => t.name)).toContain("tenant_delete_workflow");
  });
});
