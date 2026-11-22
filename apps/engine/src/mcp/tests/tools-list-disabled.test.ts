import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import {
  DRAFT_REQUIRED_MCP_UNAVAILABLE_REASON,
  DRAFT_WRITE_MCP_UNAVAILABLE_REASON,
} from "../../tools/policy.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  testEnv.SUBKIT_MCP_MODE = "authoring";
  suite = await startMcpTestSuite("tools-list-disabled");
});

afterAll(async () => {
  await suite.cleanup();
  delete testEnv.SUBKIT_MCP_MODE;
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
    expect(names.has("conversation_start")).toBe(true);
  });

  test("confirm_tool_call is discoverable and cannot accept replacement arguments", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const replay = result.tools.find((t) => t.name === "confirm_tool_call");
    expect(replay).toBeDefined();
    expect(replay?.description).toContain("does not approve anything");
    expect(replay?.inputSchema.required).toEqual(["tool", "confirm_id"]);
    expect(replay?.inputSchema.additionalProperties).toBe(false);
    expect(replay?.annotations?.readOnlyHint).toBe(false);
    expect(replay?.annotations?.openWorldHint).toBe(true);
  });

  test("no tenant_* alias remains in the catalog", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    expect(result.tools.filter((t) => t.name.startsWith("tenant_")).length).toBe(0);
  });

  test("the previously-trimmed long tail is advertised by name in authoring mode", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const names = new Set(result.tools.map((t) => t.name));
    for (const longTail of [
      "call_connector",
      "list_skills",
      "list_knowledge_sources",
      "get_raw_result",
      "dry_run_transform",
      "search_docs",
    ]) {
      expect(names.has(longTail)).toBe(true);
    }
  });
});

describe("mcp tools/call — disabled tools short-circuit", () => {
  test("save_workflow_draft returns not_available_on_surface — no 500, no audit row", async () => {
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
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0]!.text) as {
      error_code?: string;
      reason?: string;
    };
    expect(data.error_code).toBe("not_available_on_surface");
    expect(data.reason).toBe(DRAFT_WRITE_MCP_UNAVAILABLE_REASON);

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

  test("intake review tools require a conversation draft over MCP", async () => {
    const authoringClient = await suite.connect();
    const calls = [
      { client: authoringClient, name: "list_intake_items", arguments: {} },
      {
        client: authoringClient,
        name: "get_intake_item",
        arguments: { id: "10000000-0000-4000-8000-000000000001" },
      },
    ] as const;

    for (const call of calls) {
      const { client, ...request } = call;
      const result = await client.callTool(request);
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0]!.text) as { error_code?: string; reason?: string };
      expect(data.error_code).toBe("not_available_on_surface");
      expect(data.reason).toBe(DRAFT_REQUIRED_MCP_UNAVAILABLE_REASON);
    }
  });
});
