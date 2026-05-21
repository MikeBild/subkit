// Honest-surface contract: draft-write tools surface in MCP tools/list
// with explicit disabled metadata rather than being silently hidden.
// MCP tools/call for them returns `not_available_on_surface`, short-
// circuiting before commitWorkflowAtomic's elicitation gate can be
// bypassed and before any audit row is written.
//
// We force authoring MCP mode via SK_MCP_MODE so the principal sees
// conversation tools (and thus the draft_write disabled descriptors).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  process.env.SK_MCP_MODE = "authoring";
  suite = await startMcpTestSuite("tools-list-disabled");
});

afterAll(async () => {
  await suite.cleanup();
  delete process.env.SK_MCP_MODE;
});

describe("mcp tools/list — disabled descriptors (authoring mode)", () => {
  test("includes save_workflow_draft with _meta.subkit.disabled.reason", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const saveDraft = result.tools.find((t) => t.name === "save_workflow_draft");
    expect(saveDraft).toBeDefined();
    const meta = (saveDraft as Record<string, unknown>)._meta as
      | { subkit?: { disabled?: { reason?: string } } }
      | undefined;
    expect(meta?.subkit?.disabled?.reason).toContain("conversation_start");
  });

  test("includes dry_run_workflow with _meta.subkit.disabled.reason", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const dryRun = result.tools.find((t) => t.name === "dry_run_workflow");
    expect(dryRun).toBeDefined();
    const meta = (dryRun as Record<string, unknown>)._meta as
      | { subkit?: { disabled?: { reason?: string } } }
      | undefined;
    expect(meta?.subkit?.disabled?.reason).toContain("conversation_start");
  });
});

describe("mcp tools/call — disabled tools short-circuit", () => {
  test("save_workflow_draft returns not_available_on_surface — no 500, no audit row", async () => {
    // Count mcp_tool_call audits before/after to assert no APPROVAL_*
    // row was written (the short-circuit must happen before policyDecide
    // can audit). api_key.used and other unrelated audits are excluded
    // by the resource_type filter.
    const baselineRows = await suite.http.db
      .select({ c: count() })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, suite.http.tenantId),
          eq(auditLog.resource_type, "mcp_tool_call"),
        ),
      );
    const baseline = baselineRows[0]?.c ?? 0;

    const client = await suite.connect();
    const result = await client.callTool({
      name: "save_workflow_draft",
      arguments: { force_commit: false },
    });
    // Adapter renders not_available_on_surface as isError:true with a
    // structured error_code in the content body — NOT a 500.
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0]!.text) as {
      error_code?: string;
      reason?: string;
    };
    expect(data.error_code).toBe("not_available_on_surface");
    expect(data.reason).toContain("conversation_start");

    // Critical safety: short-circuit must happen BEFORE any audit row.
    const afterRows = await suite.http.db
      .select({ c: count() })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, suite.http.tenantId),
          eq(auditLog.resource_type, "mcp_tool_call"),
        ),
      );
    expect((afterRows[0]?.c ?? 0) - baseline).toBe(0);
  });

  test("dry_run_workflow returns not_available_on_surface", async () => {
    const client = await suite.connect();
    const result = await client.callTool({
      name: "dry_run_workflow",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0]!.text) as {
      error_code?: string;
      reason?: string;
    };
    expect(data.error_code).toBe("not_available_on_surface");
    expect(data.reason).toContain("conversation_start");
  });
});
