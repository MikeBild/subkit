import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb } from "../../../db/client.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  type McpClientLike,
} from "../../../mcp/client/pool.ts";
import { seedMcpConnector } from "../../../mcp/client/test-fixtures.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { getConnector } from "../../service.ts";
import type { ConnectorView } from "../../types.ts";
import { invokeMcpConnectorCall } from "../mcp.ts";

interface SeenCall {
  name: string;
  arguments: unknown;
  timeout: number | undefined;
}

const seenCalls: SeenCall[] = [];

const fakeClient: McpClientLike = {
  async connect() {},
  async listTools() {
    return { tools: [{ name: "search", description: "search", inputSchema: { type: "object" } }] };
  },
  async callTool(params, _schema, options) {
    seenCalls.push({ name: params.name, arguments: params.arguments, timeout: options?.timeout });
    return {
      content: [{ type: "text", text: "found" }],
      structuredContent: { hits: 1 },
      isError: false,
    };
  },
  async readResource() {
    return { contents: [{ uri: "file:///a", text: "alpha" }] };
  },
  async getPrompt() {
    return { messages: [] };
  },
  async close() {},
};

let ctx: TestDb;
let tenantA: string;
let tenantB: string;
let connector: ConnectorView;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: () => fakeClient });
  ctx = await createTestDb("mcp-driver-invoke");
  await closeDb();
  process.env.DATABASE_URL = ctx.url;
  tenantA = (await seedTenant(ctx.db, { slug: "t-mcp-invoke-a", display_name: "MCP A" })).id;
  tenantB = (await seedTenant(ctx.db, { slug: "t-mcp-invoke-b", display_name: "MCP B" })).id;
  const seeded = await seedMcpConnector(ctx.db, {
    tenant_id: tenantA,
    slug: "docs",
    url: "https://docs.mcpinvoketest.example.com/mcp",
    remote_tool_call_timeout_ms: 5_000,
  });
  const view = await getConnector(tenantA, seeded.id, ctx.db);
  if (!view) throw new Error("connector_fixture_missing");
  connector = view;
}, 30_000);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await closeDb();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await ctx.cleanup();
}, 30_000);

describe("invokeMcpConnectorCall", () => {
  test("a tool call forwards name, arguments and the configured timeout and returns the namespaced tool", async () => {
    __resetMcpClientPoolForTests();
    seenCalls.length = 0;
    const res = await invokeMcpConnectorCall({
      db: ctx.db,
      tenant_id: tenantA,
      actor_id: null,
      actor_type: "system",
      connector,
      call: { operation: "call_tool", tool: "search", arguments: { q: "x" } },
    });
    expect(seenCalls).toEqual([{ name: "search", arguments: { q: "x" }, timeout: 5_000 }]);
    expect(res).toMatchObject({
      ok: true,
      content: [{ type: "text", text: "found" }],
      structured_content: { hits: 1 },
      failure: null,
      wire_method: "tools/call",
      tool_name: "mcp_docs__search",
    });
    expect(res.bytes).toBeGreaterThan(0);
  });

  test("a resource read carries no tool name and no structured content", async () => {
    __resetMcpClientPoolForTests();
    const res = await invokeMcpConnectorCall({
      db: ctx.db,
      tenant_id: tenantA,
      actor_id: null,
      actor_type: "system",
      connector,
      call: { operation: "read_resource", uri: "file:///a" },
    });
    expect(res.ok).toBe(true);
    expect(res.wire_method).toBe("resources/read");
    expect("tool_name" in res).toBe(false);
    expect("structured_content" in res).toBe(false);
  });

  test("another tenant cannot reach the connector by its id", async () => {
    __resetMcpClientPoolForTests();
    seenCalls.length = 0;
    const res = await invokeMcpConnectorCall({
      db: ctx.db,
      tenant_id: tenantB,
      actor_id: null,
      actor_type: "system",
      connector: { ...connector, tenant_id: tenantB },
      call: { operation: "call_tool", tool: "search", arguments: {} },
    });
    expect(seenCalls).toHaveLength(0);
    expect(res).toMatchObject({ ok: false, failure: "not_connected", bytes: 0 });
  });
});
