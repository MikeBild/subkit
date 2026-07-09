// Non-trapping surface contract: draft-write tools are conversation-
// scoped (only the engine's internal authoring loop, started via
// conversation_start, may call them). They are OMITTED from MCP
// tools/list so external clients that ignore a disabled badge cannot
// see and churn on them. A stateless tools/call for them still short-
// circuits to `not_available_on_surface` (resolve() keeps the disabled
// descriptor) before commitWorkflowAtomic's elicitation gate can be
// bypassed and before any audit row is written.
//
// We force authoring MCP mode via SK_MCP_MODE so the principal would
// otherwise see conversation tools (and the draft_write descriptors).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { DRAFT_WRITE_MCP_UNAVAILABLE_REASON } from "../../tools/policy.ts";
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

describe("mcp tools/list — draft_write omitted (authoring mode)", () => {
  test("save_workflow_draft is NOT listed", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    expect(result.tools.find((t) => t.name === "save_workflow_draft")).toBeUndefined();
  });

  test("dry_run_workflow is NOT listed", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    expect(result.tools.find((t) => t.name === "dry_run_workflow")).toBeUndefined();
  });

  test("no draft_write authoring tool leaks into the catalog", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const names = new Set(result.tools.map((t) => t.name));
    for (const trap of [
      "author_workflow",
      "build_workflow",
      "edit_workflow_patch",
      "update_param",
      "connect_steps",
      "propose_step",
    ]) {
      expect(names.has(trap)).toBe(false);
    }
    // conversation_start IS the authoring entry point and must stay listed.
    expect(names.has("conversation_start")).toBe(true);
  });

  test("confirm_tool_call is NOT listed — MCP writes execute directly", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    expect(result.tools.some((t) => t.name === "confirm_tool_call")).toBe(false);
  });

  test("catalog stays under the size ceiling (no draft_write traps, no tenant_* duplicates)", async () => {
    // Tool-selection accuracy degrades past ~30-50 tools and large
    // catalogs bloat every turn's context. Before this change the
    // authoring-mode catalog carried a full tenant_* duplicate set + 19
    // listed-but-uncallable draft_write tools, pushing well past 100.
    // Hold the line so future additions are a deliberate choice, not drift.
    const client = await suite.connect();
    const result = await client.listTools();
    // Deliberate ceiling, raised as tools are consciously added:
    //   +2 grounding read tools — `list_capability_gaps` (durable capability
    //      gaps) and `suggest_related_conversations` (topic routing).
    //   +1 `run_workflow` — the search-first workflow runner is now exempt
    //      from the readOnly-implied hide so it surfaces in authoring/admin too
    //      (RBAC still gates execution); it was previously hidden here.
    // `confirm_tool_call` is GONE (MCP writes execute directly, gated by the
    // client's own destructiveHint dialog — see tools/policy.ts), so it no
    // longer counts toward this ceiling.
    // Keep the guard tight so further additions stay a conscious choice,
    // not drift.
    expect(result.tools.length).toBeLessThan(85);
    // No tenant_* alias should remain in the catalog.
    expect(result.tools.filter((t) => t.name.startsWith("tenant_")).length).toBe(0);
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
    expect(data.reason).toBe(DRAFT_WRITE_MCP_UNAVAILABLE_REASON);

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
    expect(data.reason).toBe(DRAFT_WRITE_MCP_UNAVAILABLE_REASON);
  });
});
