import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb } from "../../db/client.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  evictServer,
  evictTenant,
  getTenantMcpTools,
  type McpClientLike,
} from "./pool.ts";
import { seedMcpConnector } from "./test-fixtures.ts";

const connectCounts = new Map<string, number>();

function makeFakeClient(url: string): McpClientLike {
  return {
    async connect() {
      connectCounts.set(url, (connectCounts.get(url) ?? 0) + 1);
    },
    async listTools() {
      return {
        tools: [
          {
            name: "stub_tool",
            description: "stub",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    },
    async callTool() {
      return { content: [], isError: false };
    },
    async readResource() {
      return { contents: [] };
    },
    async getPrompt() {
      return { messages: [] };
    },
    async close() {},
  };
}

let ctx: TestDb;
let tenantId: string;
const _origDatabaseUrl = testEnv.DATABASE_URL;

async function seedServer(slug: string, host: string): Promise<{ id: string; url: string }> {
  const url = `https://${host}.evicttest.example.com/mcp`;
  const row = await seedMcpConnector(ctx.db, { tenant_id: tenantId, slug, transport: "http", url });
  return { id: row.id, url };
}

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: (row) => makeFakeClient(row.url) });
  ctx = await createTestDb("mcp-pool-evict");
  await closeDb();
  testEnv.DATABASE_URL = ctx.url;
  const t = await seedTenant(ctx.db, { slug: "t-pool-evict", display_name: "Pool Evict Tenant" });
  tenantId = t.id;
}, 30_000);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await closeDb();
  if (_origDatabaseUrl === undefined) delete testEnv.DATABASE_URL;
  else testEnv.DATABASE_URL = _origDatabaseUrl;
  await ctx.cleanup();
}, 30_000);

describe("evictServer vs evictTenant", () => {
  test("evictServer re-handshakes ONLY the evicted server; the sibling stays warm", async () => {
    __resetMcpClientPoolForTests();
    connectCounts.clear();
    const a = await seedServer("evicta", "alpha");
    const b = await seedServer("evictb", "bravo");

    await getTenantMcpTools(ctx.db, tenantId, { requestSource: "api" });
    expect(connectCounts.get(a.url)).toBe(1);
    expect(connectCounts.get(b.url)).toBe(1);

    evictServer(tenantId, a.id);
    await getTenantMcpTools(ctx.db, tenantId, { requestSource: "api" });

    expect(connectCounts.get(a.url)).toBe(2);
    expect(connectCounts.get(b.url)).toBe(1);
  });

  test("evictTenant drops every server so all re-handshake", async () => {
    __resetMcpClientPoolForTests();
    connectCounts.clear();
    const a = await seedServer("tevicta", "charlie");
    const b = await seedServer("tevictb", "delta");

    await getTenantMcpTools(ctx.db, tenantId, { requestSource: "api" });
    expect(connectCounts.get(a.url)).toBe(1);
    expect(connectCounts.get(b.url)).toBe(1);

    evictTenant(tenantId);
    await getTenantMcpTools(ctx.db, tenantId, { requestSource: "api" });

    expect(connectCounts.get(a.url)).toBe(2);
    expect(connectCounts.get(b.url)).toBe(2);
  });

  test("evictServer is a no-op for an unknown tenant / server (no throw)", () => {
    expect(() => evictServer("00000000-0000-0000-0000-0000000000ff", "deadbeef")).not.toThrow();
  });
});
