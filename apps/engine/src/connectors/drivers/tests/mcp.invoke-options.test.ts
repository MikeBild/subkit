import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { closeDb } from "../../../db/client.ts";
import { auditLog } from "../../../db/schema/index.ts";
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

const events: string[] = [];
const seenSignals: Array<AbortSignal | undefined> = [];

const fakeClient: McpClientLike = {
  async connect() {},
  async listTools() {
    return { tools: [{ name: "search", description: "search", inputSchema: { type: "object" } }] };
  },
  async callTool(_params, _schema, options) {
    events.push("remote_call");
    seenSignals.push(options?.signal);
    return { content: [{ type: "text", text: "ok" }], isError: false };
  },
  async readResource() {
    return { contents: [] };
  },
  async getPrompt() {
    return { messages: [] };
  },
  async close() {},
};

let ctx: TestDb;
let tenantId: string;
let plain: ConnectorView;
const originalDatabaseUrl = process.env.DATABASE_URL;

async function viewOf(id: string): Promise<ConnectorView> {
  const view = await getConnector(tenantId, id, ctx.db);
  if (!view) throw new Error("connector_fixture_missing");
  return view;
}

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: () => fakeClient });
  ctx = await createTestDb("mcp-driver-invoke-options");
  await closeDb();
  process.env.DATABASE_URL = ctx.url;
  tenantId = (await seedTenant(ctx.db, { slug: "t-mcp-invoke-opt", display_name: "MCP Opt" })).id;
  const plainRow = await seedMcpConnector(ctx.db, {
    tenant_id: tenantId,
    slug: "plain",
    url: "https://plain.mcpinvokeopt.example.com/mcp",
  });
  plain = await viewOf(plainRow.id);
}, 30_000);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await closeDb();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await ctx.cleanup();
}, 30_000);

describe("invokeMcpConnectorCall caller hooks", () => {
  test("the dispatch hook fires once, right before the remote call", async () => {
    __resetMcpClientPoolForTests();
    events.length = 0;
    const res = await invokeMcpConnectorCall({
      db: ctx.db,
      tenant_id: tenantId,
      actor_id: null,
      actor_type: "system",
      connector: plain,
      call: { operation: "call_tool", tool: "search", arguments: {} },
      on_dispatch: () => events.push("dispatch"),
    });
    expect(res.ok).toBe(true);
    expect(events).toEqual(["dispatch", "remote_call"]);
  });

  test("the caller's abort signal reaches the remote call", async () => {
    __resetMcpClientPoolForTests();
    seenSignals.length = 0;
    const controller = new AbortController();
    await invokeMcpConnectorCall({
      db: ctx.db,
      tenant_id: tenantId,
      actor_id: null,
      actor_type: "system",
      connector: plain,
      call: { operation: "call_tool", tool: "search", arguments: {} },
      signal: controller.signal,
    });
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]).toBe(controller.signal);
  });

  test("the tool invocation audit row names the caller's request source", async () => {
    __resetMcpClientPoolForTests();
    await invokeMcpConnectorCall({
      db: ctx.db,
      tenant_id: tenantId,
      actor_id: null,
      actor_type: "system",
      connector: plain,
      call: { operation: "call_tool", tool: "search", arguments: {} },
      requestSource: "api",
    });
    const rows = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, "mcp_external_tool.invoked")),
      );
    const sources = rows.map((r) => (r.metadata as { request_source?: string }).request_source);
    expect(sources).toContain("api");
  });
});
