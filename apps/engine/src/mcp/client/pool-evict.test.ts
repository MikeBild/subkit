// Granular vs. tenant-wide pool eviction (#226 S3).
//
// `evictServer(tenant, server)` must drop ONLY the targeted server's cached
// client + backoff window, leaving every other server in the same tenant
// pool warm. `evictTenant(tenant)` drops the whole tenant. We assert the
// difference by counting handshakes per server URL across re-fetches: an
// evicted server re-handshakes on the next `getTenantMcpTools`; a server
// left warm does not.
//
// MOCK PATTERN: mock.module() runs BEFORE the dynamic import of pool.ts so
// the stubbed SDK is resolved on first load (static imports hoist; the
// dynamic await import() below does not).

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { closeDb } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createMcpServer } from "./registry.ts";

const realSdkIndex = await import("@modelcontextprotocol/sdk/client/index.js");
const realSdkAuth = await import("@modelcontextprotocol/sdk/client/auth.js");
const realSdkStreamableHttp = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

// Per-URL connect (handshake) counter. The pool builds a fresh transport
// per connect attempt; the stub transport records the target URL so the
// stub client can bump the counter for the right server. Tests run serially.
const connectCounts = new Map<string, number>();
let activeTransportUrl = "";

class StubStreamableHTTPTransport {
  constructor(url: URL) {
    activeTransportUrl = url.toString();
  }
}

class StubClient {
  #url = "";
  async connect(_transport: unknown): Promise<void> {
    this.#url = activeTransportUrl;
    connectCounts.set(this.#url, (connectCounts.get(this.#url) ?? 0) + 1);
  }
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
  }
  async close(): Promise<void> {}
}

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  ...realSdkIndex,
  Client: StubClient,
}));
mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  ...realSdkStreamableHttp,
  StreamableHTTPClientTransport: StubStreamableHTTPTransport,
}));

const { getTenantMcpTools, evictServer, evictTenant, __resetMcpClientPoolForTests } = await import(
  "./pool.ts"
);

let ctx: TestDb;
let tenantId: string;
const _origDatabaseUrl = process.env.DATABASE_URL;

function auditCtx() {
  return {
    actor_id: "00000000-0000-0000-0000-000000000001",
    request_source: "api" as const,
    executor: ctx.db,
  };
}

// Both servers use `none` auth so connect always succeeds (no credential).
async function seedServer(namespace: string, host: string): Promise<{ id: string; url: string }> {
  const url = `https://${host}.evicttest.example.com/mcp`;
  const row = await createMcpServer(
    ctx.db,
    { tenant_id: tenantId, name: namespace, namespace, transport: "http", url },
    auditCtx(),
  );
  return { id: row.id, url };
}

beforeAll(async () => {
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
  await closeDb();
  if (_origDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = _origDatabaseUrl;
  mock.module("@modelcontextprotocol/sdk/client/index.js", () => realSdkIndex);
  mock.module("@modelcontextprotocol/sdk/client/auth.js", () => realSdkAuth);
  mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => realSdkStreamableHttp);
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
