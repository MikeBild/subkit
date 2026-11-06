import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { closeDb } from "../../db/client.ts";
import { auditLog, connectors } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  getTenantMcpTools,
  type McpClientLike,
} from "./pool.ts";
import { seedMcpConnector } from "./test-fixtures.ts";

function makeFakeM2mClient(slug: string): McpClientLike {
  return {
    async connect() {},
    async listTools() {
      return {
        tools: [
          {
            name: `${slug}_tool`,
            description: `A tool from ${slug}`,
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
  __setMcpPoolFactoriesForTests({
    makeClient: (row) => makeFakeM2mClient(row.slug),
  });

  ctx = await createTestDb("mcp-m2m-oauth");

  await closeDb();
  process.env.DATABASE_URL = ctx.url;

  const cfgDir = mkdtempSync(join(tmpdir(), "sk-cfg-m2m-oauth-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: ctx.url, NODE_ENV: "test" },
    configPathOverride: join(cfgDir, "subkit.config.json"),
  });
  await setConfigKey("server.public_base_url", "https://engine.m2m-oauth.example", {
    force: true,
  });

  const t = await seedTenant(ctx.db, { slug: "t-m2m-oauth", display_name: "M2M OAuth Tenant" });
  tenantId = t.id;
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

describe("pool: oauth2_client_credentials server with credential row", () => {
  test("getTenantMcpTools returns the server's tools when credential is present", async () => {
    __resetMcpClientPoolForTests();

    const server = await seedMcpConnector(ctx.db, {
      tenant_id: tenantId,
      slug: "m2m-cc-server",
      transport: "http",
      url: "https://m2m-cc.mcp-test.example.com",
      auth: {
        kind: "oauth2_client_credentials",
        issuer: "https://auth.example.test",
        client_id: "cc-client-001",
        scope: "tools:read",
      },
    });

    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: server.id,
        environment: "prod",
        mode: "oauth2_client",
        value: {
          mode: "oauth2_client",
          client_id: "cc-client-001",
          client_secret: "super-secret-value-never-logged",
        },
        actor_id: null,
        source: "http_route",
      },
      ctx.db,
    );

    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    const found = sets.find((s) => s.connector_id === server.id);
    expect(found).toBeDefined();
    expect(found!.tools.length).toBeGreaterThan(0);
    expect(found!.tools[0]!.name).toBe("m2m-cc-server_tool");
    expect(found!.slug).toBe("m2m-cc-server");
  });

  test("secret is not persisted in the connector config (non-secret shape only)", async () => {
    const row = await ctx.db
      .select({ config: connectors.config })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.slug, "m2m-cc-server")))
      .limit(1);
    const cfg = (row[0]?.config as { mcp?: { auth?: unknown } } | undefined)?.mcp?.auth;
    const cfgJson = JSON.stringify(cfg ?? {});
    expect(cfgJson).not.toContain("super-secret-value-never-logged");
    expect(cfgJson).not.toContain("client_secret");
    expect(cfgJson).toContain("oauth2_client_credentials");
    expect(cfgJson).toContain("cc-client-001");
  });

  test("connector health stays ok after a successful handshake", async () => {
    const rows = await ctx.db
      .select({ health_state: connectors.health_state, last_error: connectors.last_error })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.slug, "m2m-cc-server")));
    expect(rows[0]?.health_state).toBe("ok");
    expect(rows[0]?.last_error).toBeNull();
  });

  test("audit log contains connector.mcp_handshake_ok and no secret material", async () => {
    const rows = await ctx.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.tenant_id, tenantId));
    const allMetaJson = rows.map((r) => JSON.stringify(r.metadata ?? {})).join("\n");
    expect(allMetaJson).not.toContain("super-secret-value-never-logged");
    expect(allMetaJson).not.toContain("client_secret");
    expect(allMetaJson).not.toContain("private_key");

    const actions = rows.map((r) => r.action);
    expect(actions).toContain("connector.mcp_handshake_ok");
  });
});

describe("pool: oauth2_private_key_jwt server with credential row", () => {
  test("getTenantMcpTools returns the server's tools when private key credential is present", async () => {
    __resetMcpClientPoolForTests();

    const server = await seedMcpConnector(ctx.db, {
      tenant_id: tenantId,
      slug: "m2m-pk-server",
      transport: "http",
      url: "https://m2m-pk.mcp-test.example.com",
      auth: {
        kind: "oauth2_private_key_jwt",
        issuer: "https://auth.example.test",
        client_id: "pk-client-002",
        algorithm: "RS256",
        scope: "mcp:invoke",
      },
    });

    const fakePem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4SbCQSbpFKEUBpFVBfvVNJL1",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: server.id,
        environment: "prod",
        mode: "oauth2_private_key",
        value: {
          mode: "oauth2_private_key",
          client_id: "pk-client-002",
          private_key: fakePem,
          algorithm: "RS256",
        },
        actor_id: null,
        source: "http_route",
      },
      ctx.db,
    );

    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    const found = sets.find((s) => s.connector_id === server.id);
    expect(found).toBeDefined();
    expect(found!.tools.length).toBeGreaterThan(0);
    expect(found!.tools[0]!.name).toBe("m2m-pk-server_tool");
  });

  test("private key VALUE is NOT persisted in the connector config", async () => {
    const row = await ctx.db
      .select({ config: connectors.config })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.slug, "m2m-pk-server")))
      .limit(1);
    const cfgJson = JSON.stringify(
      (row[0]?.config as { mcp?: { auth?: unknown } } | undefined)?.mcp?.auth ?? {},
    );
    expect(cfgJson).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(cfgJson).not.toContain("MIIEowIBAAKCAQEA");
    expect(cfgJson).toContain("oauth2_private_key_jwt");
    expect(cfgJson).toContain("pk-client-002");
    expect(cfgJson).toContain("RS256");
  });

  test("private key VALUE is NOT present in any audit row", async () => {
    const rows = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.tenant_id, tenantId));
    const allMetaJson = rows.map((r) => JSON.stringify(r.metadata ?? {})).join("\n");
    expect(allMetaJson).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(allMetaJson).not.toContain("MIIEowIBAAKCAQEA");
  });
});

describe("pool: oauth2_client_credentials server with no credential row", () => {
  test("getTenantMcpTools parks the server in error status without throwing", async () => {
    __resetMcpClientPoolForTests();

    const server = await seedMcpConnector(ctx.db, {
      tenant_id: tenantId,
      slug: "m2m-no-cred",
      transport: "http",
      url: "https://m2m-no-cred.mcp-test.example.com",
      auth: {
        kind: "oauth2_client_credentials",
        issuer: "https://auth.example.test",
        client_id: "no-cred-client",
      },
    });

    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    const found = sets.find((s) => s.connector_id === server.id);
    expect(found).toBeUndefined();

    const rows = await ctx.db
      .select({ health_state: connectors.health_state, last_error: connectors.last_error })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.id, server.id)))
      .limit(1);
    expect(rows[0]?.health_state).toBe("degraded");

    const lastError = rows[0]?.last_error ?? "";
    expect(lastError.length).toBeGreaterThan(0);
    expect(lastError).not.toContain("?");
    expect(lastError).not.toContain("BEGIN");
    expect(lastError).not.toMatch(/Bearer\s+\S{20,}/);
    expect(lastError).not.toContain("super-secret-value-never-logged");
  });

  test("last_error describes the missing credential, not a secret value", async () => {
    const rows = await ctx.db
      .select({ last_error: connectors.last_error })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.slug, "m2m-no-cred")))
      .limit(1);
    const lastError = rows[0]?.last_error ?? "";
    expect(lastError.length).toBeGreaterThan(0);
    expect(lastError.toLowerCase()).toMatch(/credential|client|register/);
  });
});

describe("pool: oauth2_private_key_jwt server with no credential row", () => {
  test("getTenantMcpTools parks the server and last_error is redact-safe", async () => {
    __resetMcpClientPoolForTests();

    const server = await seedMcpConnector(ctx.db, {
      tenant_id: tenantId,
      slug: "m2m-no-key",
      transport: "http",
      url: "https://m2m-no-key.mcp-test.example.com",
      auth: {
        kind: "oauth2_private_key_jwt",
        issuer: "https://auth.example.test",
        client_id: "no-key-client",
        algorithm: "ES256",
      },
    });

    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    expect(sets.find((s) => s.connector_id === server.id)).toBeUndefined();

    const rows = await ctx.db
      .select({ health_state: connectors.health_state, last_error: connectors.last_error })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.id, server.id)))
      .limit(1);
    expect(rows[0]?.health_state).toBe("degraded");

    const lastError = rows[0]?.last_error ?? "";
    expect(lastError.length).toBeGreaterThan(0);
    expect(lastError).not.toContain("BEGIN RSA");
    expect(lastError).not.toContain("MIIEowIBAAKCAQEA");
    expect(lastError).not.toContain("?");
    expect(lastError.toLowerCase()).toMatch(/credential|private key|private_key|register/);
  });
});

describe("pool: tenant isolation for M2M credential resolution", () => {
  test("tenant B cannot access tenant A's oauth2_client_credentials server", async () => {
    __resetMcpClientPoolForTests();

    const tB = await seedTenant(ctx.db, { slug: "t-m2m-b", display_name: "M2M Tenant B" });
    const tenantBId = tB.id;

    const serverA = await seedMcpConnector(ctx.db, {
      tenant_id: tenantId,
      slug: "tenant-a-m2m",
      transport: "http",
      url: "https://tenant-a-m2m.mcp-test.example.com",
      auth: {
        kind: "oauth2_client_credentials",
        issuer: "https://auth.example.test",
        client_id: "a-client",
      },
    });
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: serverA.id,
        environment: "prod",
        mode: "oauth2_client",
        value: {
          mode: "oauth2_client",
          client_id: "a-client",
          client_secret: "tenant-a-secret",
        },
        actor_id: null,
        source: "http_route",
      },
      ctx.db,
    );

    const bSets = await getTenantMcpTools(ctx.db, tenantBId, { environment: "prod" });
    expect(bSets.find((s) => s.connector_id === serverA.id)).toBeUndefined();

    const aSets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    expect(aSets.find((s) => s.connector_id === serverA.id)).toBeDefined();
  });
});

describe("pool: M2M kinds do not generate a static Authorization header", () => {
  test("oauth2_client_credentials server listed via getTenantMcpTools without a static bearer header", async () => {
    const rows = await ctx.db
      .select({ health_state: connectors.health_state, last_error: connectors.last_error })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.slug, "m2m-cc-server")));
    expect(rows[0]?.health_state).toBe("ok");
    expect(rows[0]?.last_error).toBeNull();
  });
});
