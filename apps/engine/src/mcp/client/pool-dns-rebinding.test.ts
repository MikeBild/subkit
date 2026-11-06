import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import { closeDb } from "../../db/client.ts";
import { connectors } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  getTenantMcpTools,
  type McpClientLike,
} from "./pool.ts";
import { getMcpConnector } from "./registry.ts";
import { seedMcpConnector } from "./test-fixtures.ts";

let ctx: TestDb;
const origDatabaseUrl = process.env.DATABASE_URL;
let origEgressMode: "strict" | "permissive" | null | undefined;

let connects = 0;
function fakeClient(): McpClientLike {
  return {
    async connect() {
      connects += 1;
    },
    async listTools() {
      return { tools: [{ name: "stub", description: "s", inputSchema: { type: "object" } }] };
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

function resolverAnswering(address: string) {
  return (async () => [{ address, family: address.includes(":") ? 6 : 4 }]) as never;
}

async function freshTenant(slug: string): Promise<string> {
  const t = await seedTenant(ctx.db, { slug, display_name: slug });
  return t.id;
}

async function seed(tenant_id: string, slug: string): Promise<string> {
  const row = await seedMcpConnector(ctx.db, {
    tenant_id,
    slug,
    transport: "http",
    url: `https://${slug}.rebindtest.example.com/mcp`,
  });
  return row.id;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "sk-mcp-rebind-"));
  await loadConfig({
    env: { DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/subkit" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
  origEgressMode = getConfig().egress.mode;
  await setConfigKey("egress.mode", "strict", { force: true });
  ctx = await createTestDb("mcp-pool-dns-rebinding");
  process.env.DATABASE_URL = ctx.url;
}, 60_000);

afterEach(() => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  connects = 0;
});

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  if (origEgressMode !== undefined) {
    await setConfigKey("egress.mode", origEgressMode ?? null, { force: true });
  }
  await closeDb();
  if (origDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = origDatabaseUrl;
  await ctx?.cleanup();
}, 30_000);

describe("a registered host that later resolves to a private address", () => {
  test("is refused at connect, and no handshake is attempted", async () => {
    const tenant = await freshTenant("rebind-loopback");
    const id = await seed(tenant, "rebound");
    __setMcpPoolFactoriesForTests({
      makeClient: () => fakeClient(),
      lookupDns: resolverAnswering("127.0.0.1"),
    });

    const tools = await getTenantMcpTools(ctx.db, tenant);

    expect(tools.length).toBe(0);
    expect(connects).toBe(0);

    expect(await getMcpConnector(ctx.db, tenant, id)).not.toBeNull();
    const parked = await ctx.db
      .select({ last_error: connectors.last_error })
      .from(connectors)
      .where(eq(connectors.id, id))
      .limit(1);
    expect(parked[0]?.last_error ?? "").toContain("private_ip_resolved");
  }, 60_000);

  test("a cloud metadata address is refused the same way", async () => {
    const tenant = await freshTenant("rebind-metadata");
    await seed(tenant, "metadata");
    __setMcpPoolFactoriesForTests({
      makeClient: () => fakeClient(),
      lookupDns: resolverAnswering("169.254.169.254"),
    });

    expect((await getTenantMcpTools(ctx.db, tenant)).length).toBe(0);
    expect(connects).toBe(0);
  }, 60_000);

  test("an RFC1918 address is refused the same way", async () => {
    const tenant = await freshTenant("rebind-rfc1918");
    await seed(tenant, "internal");
    __setMcpPoolFactoriesForTests({
      makeClient: () => fakeClient(),
      lookupDns: resolverAnswering("10.0.0.7"),
    });

    expect((await getTenantMcpTools(ctx.db, tenant)).length).toBe(0);
    expect(connects).toBe(0);
  }, 60_000);
});

describe("a host that still resolves publicly", () => {
  test("connects normally — the gate is not a blanket denial", async () => {
    const tenant = await freshTenant("rebind-public");
    await seed(tenant, "still-public");
    __setMcpPoolFactoriesForTests({
      makeClient: () => fakeClient(),
      lookupDns: resolverAnswering("93.184.216.34"),
    });

    const tools = await getTenantMcpTools(ctx.db, tenant);
    expect(tools.length).toBeGreaterThan(0);
    expect(connects).toBe(1);
  }, 60_000);
});
