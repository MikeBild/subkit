import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { and, eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { closeDb } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  getTenantMcpTools,
  type McpClientLike,
} from "./pool.ts";
import { seedMcpConnector } from "./test-fixtures.ts";

function makeFakeClient(slug: string): McpClientLike {
  return {
    async connect() {
      if (slug === "oauth2server") {
        throw new UnauthorizedError("no usable token");
      }
    },
    async listTools() {
      return {
        tools: [
          {
            name: "acme_tool",
            description: "A stub tool from the bearer server",
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

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: (row) => makeFakeClient(row.slug) });
  ctx = await createTestDb("mcp-pool-needs-auth");

  await closeDb();
  process.env.DATABASE_URL = ctx.url;

  const cfgDir = mkdtempSync(join(tmpdir(), "sk-cfg-pool-needs-auth-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: ctx.url, NODE_ENV: "test" },
    configPathOverride: join(cfgDir, "subkit.config.json"),
  });
  await setConfigKey("server.public_base_url", "https://engine.poolauth.example", { force: true });

  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-pool-auth", display_name: "Pool Auth Tenant" })
    .returning();
  tenantId = t!.id;
}, 30_000);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  _resetConfigForTests();

  await closeDb();
  if (_origDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = _origDatabaseUrl;
  }

  await ctx.cleanup();
}, 30_000);

describe("pool: oauth2 server with no tokens is parked; bearer server still returned", () => {
  test("getTenantMcpTools skips the unauthorized oauth2 server and returns the bearer server's tools", async () => {
    __resetMcpClientPoolForTests();

    const oauth2Server = await seedMcpConnector(ctx.db, {
      tenant_id: tenantId,
      slug: "oauth2server",
      transport: "http",
      url: "https://oauth2server.acmeauth.test/mcp",
      auth: {
        kind: "oauth2",
        issuer: "https://auth.acmeauth.test",
      },
    });

    const bearerServer = await seedMcpConnector(ctx.db, {
      tenant_id: tenantId,
      slug: "bearerserver",
      transport: "http",
      url: "https://bearerserver.acmeauth.test/mcp",
      auth: { kind: "bearer" },
    });

    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: bearerServer.id,
        environment: "prod",
        mode: "bearer",
        value: { mode: "bearer", token: "bearer-token-abc" },
        actor_id: null,
        source: "oauth_callback",
      },
      ctx.db,
    );

    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });

    const bearerSet = sets.find((s) => s.connector_id === bearerServer.id);
    expect(bearerSet).toBeDefined();
    expect(bearerSet!.tools.length).toBeGreaterThan(0);
    expect(bearerSet!.tools[0]!.name).toBe("acme_tool");

    const oauth2Set = sets.find((s) => s.connector_id === oauth2Server.id);
    expect(oauth2Set).toBeUndefined();
  });

  test("oauth2 connector is parked degraded and last_error is redact-safe after UnauthorizedError", async () => {
    const { connectors } = await import("../../db/schema/index.ts");
    const rows = await ctx.db
      .select({ health_state: connectors.health_state, last_error: connectors.last_error })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.slug, "oauth2server")))
      .limit(1);
    expect(rows.length).toBe(1);
    expect(rows[0]!.health_state).toBe("degraded");

    const lastError = rows[0]!.last_error ?? "";
    expect(lastError).not.toContain("?");
    expect(lastError).toContain("authorization");
  });
});

describe("pool: within backoff window the tokenless server stays absent", () => {
  test("second getTenantMcpTools call still skips the failed server (backoff not yet elapsed)", async () => {
    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });

    const bearerSet = sets.find((s) => s.slug === "bearerserver");
    expect(bearerSet).toBeDefined();

    const oauth2Set = sets.find((s) => s.slug === "oauth2server");
    expect(oauth2Set).toBeUndefined();
  });
});

describe("pool: oauth2 server with no public_base_url parks with a redirect-URI error", () => {
  test("getTenantMcpTools parks the server with the typed last_error and does not connect", async () => {
    await setConfigKey("server.public_base_url", "", { force: true });
    __resetMcpClientPoolForTests();

    const server = await seedMcpConnector(ctx.db, {
      tenant_id: tenantId,
      slug: "noorigin",
      transport: "http",
      url: "https://noorigin.acmeauth.test/mcp",
      auth: { kind: "oauth2", issuer: "https://auth.acmeauth.test" },
    });

    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    expect(sets.find((s) => s.connector_id === server.id)).toBeUndefined();

    const { connectors } = await import("../../db/schema/index.ts");
    const rows = await ctx.db
      .select({ health_state: connectors.health_state, last_error: connectors.last_error })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.id, server.id)))
      .limit(1);
    expect(rows[0]!.health_state).toBe("degraded");
    const lastError = rows[0]!.last_error ?? "";
    expect(lastError).toContain("no canonical OAuth redirect URI");
    expect(lastError).toContain("server.public_base_url");
    expect(lastError).not.toContain("?");
  });
});
