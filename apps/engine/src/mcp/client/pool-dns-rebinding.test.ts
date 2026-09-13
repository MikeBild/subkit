// DNS rebinding on the MCP connect path.
//
// Registration resolves the hostname and rejects private targets. That verdict
// is only true for the DNS answer at registration time — the zone belongs to
// whoever owns the domain, and they can re-point it afterwards. A hostname that
// answered a public address when the operator registered it can answer
// 127.0.0.1 by the time the pool connects.
//
// What leaves on that connection is the tenant's resolved bearer/OAuth header.
// Sending it to a loopback or metadata address is the whole SSRF prize, so the
// resolving check has to run at connect, not only at registration.
//
// The literal check inside `buildTransport` cannot catch this: it reads the URL
// text, and the URL text never changed.
//
// STRICT MODE ON PURPOSE. `egress.mode` defaults to permissive outside
// production, and permissive skips resolution entirely — an operator who chose
// it is asking to reach private hosts. The gate under test is the production
// one, so these tests pin `strict` rather than inheriting the test default.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import { closeDb } from "../../db/client.ts";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
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
/** Restored in afterAll. `setConfigKey` mutates process-global config, and bun
 *  runs test files in a shared worker — leaving `strict` behind would silently
 *  change egress behaviour for every sibling file that runs after this one. */
let origEgressMode: "strict" | "permissive" | null | undefined;

/** Counts handshakes so a test can assert that none was attempted — the point
 *  being that the credential never reached a socket, not merely that the tool
 *  list came back empty. */
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

/** Stand-in for `dns.lookup(host, {all:true})` answering whatever the test
 *  wants — the only way to express "public at registration, private now". */
function resolverAnswering(address: string) {
  return (async () => [{ address, family: address.includes(":") ? 6 : 4 }]) as never;
}

/** A fresh tenant per test: `getTenantMcpTools` connects to every server in the
 *  tenant, so sharing one would make handshake counts cumulative across cases. */
async function freshTenant(slug: string): Promise<string> {
  const [t] = await ctx.db.insert(tenants).values({ slug, display_name: slug }).returning();
  if (!t) throw new Error("seed tenant failed");
  return t.id;
}

async function seed(tenant_id: string, slug: string): Promise<string> {
  // Registration succeeds: in this environment the host does not resolve at
  // all, which the guard deliberately treats as "not a block — let the fetch
  // report it". That is exactly the shape of a host that is benign today.
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
  // `null` is the configured "fall back to the NODE_ENV default" value, so
  // it is restored as-is rather than skipped.
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
      // The zone flipped between registration and connect.
      lookupDns: resolverAnswering("127.0.0.1"),
    });

    const tools = await getTenantMcpTools(ctx.db, tenant);

    expect(tools.length).toBe(0);
    // The load-bearing assertion: the SDK client was never asked to connect,
    // so the Authorization header never reached a socket.
    expect(connects).toBe(0);

    // Parked with the reason recorded, not silently skipped.
    // The connector is still readable and the redacted upstream text is
    // what an operator sees; `getMcpConnector` deliberately does not carry
    // it, so the assertion reads the column the pool wrote.
    expect(await getMcpConnector(ctx.db, tenant, id)).not.toBeNull();
    const parked = await ctx.db
      .select({ last_error: connectors.last_error })
      .from(connectors)
      .where(eq(connectors.id, id))
      .limit(1);
    expect(parked[0]?.last_error ?? "").toContain("private_ip_resolved");
  }, 60_000);

  test("a cloud metadata address is refused the same way", async () => {
    // 169.254.169.254 is what this class of attack actually goes for.
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
