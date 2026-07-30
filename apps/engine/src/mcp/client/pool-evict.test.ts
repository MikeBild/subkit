// Granular vs. tenant-wide pool eviction.
//
// `evictServer(tenant, server)` must drop ONLY the targeted server's cached
// client + backoff window, leaving every other server in the same tenant
// pool warm. `evictTenant(tenant)` drops the whole tenant. We assert the
// difference by counting handshakes per server URL across re-fetches: an
// evicted server re-handshakes on the next `getTenantMcpTools`; a server
// left warm does not.
//
// INJECTION PATTERN: the pool's documented TEST SEAM
// (`__setMcpPoolFactoriesForTests`) swaps the SDK Client construction for an
// in-process fake. NO bun `mock.module` — module mocks are process-global
// and leak into every other test file in the same worker.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  evictServer,
  evictTenant,
  getTenantMcpTools,
  type McpClientLike,
} from "./pool.ts";
import { seedMcpConnector } from "./test-fixtures.ts";

// Per-URL connect (handshake) counter. The factory seam hands the fake
// client its server row, so each connect bumps the counter for the right
// server. Tests run serially.
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
const _origDatabaseUrl = process.env.DATABASE_URL;

// Both servers use `none` auth so connect always succeeds (no credential).
async function seedServer(slug: string, host: string): Promise<{ id: string; url: string }> {
  const url = `https://${host}.evicttest.example.com/mcp`;
  const row = await seedMcpConnector(ctx.db, { tenant_id: tenantId, slug, transport: "http", url });
  return { id: row.id, url };
}

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: (row) => makeFakeClient(row.url) });
  ctx = await createTestDb("mcp-pool-evict");
  await closeDb();
  process.env.DATABASE_URL = ctx.url;
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-pool-evict", display_name: "Pool Evict Tenant" })
    .returning();
  tenantId = t!.id;
}, 30_000);

afterAll(async () => {
  // ALWAYS restore the seam (null-by-default protects production, but a
  // leaked non-null factory would still poison sibling test files).
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await closeDb();
  if (_origDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = _origDatabaseUrl;
  await ctx.cleanup();
}, 30_000);

describe("evictServer vs evictTenant", () => {
  test("evictServer re-handshakes ONLY the evicted server; the sibling stays warm", async () => {
    __resetMcpClientPoolForTests();
    connectCounts.clear();
    const a = await seedServer("evicta", "alpha");
    const b = await seedServer("evictb", "bravo");

    // Warm both — one handshake each.
    await getTenantMcpTools(ctx.db, tenantId, { requestSource: "api" });
    expect(connectCounts.get(a.url)).toBe(1);
    expect(connectCounts.get(b.url)).toBe(1);

    // Drop only server A; re-fetch.
    evictServer(tenantId, a.id);
    await getTenantMcpTools(ctx.db, tenantId, { requestSource: "api" });

    // A re-handshook (cached client dropped); B stayed warm (no reconnect).
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
