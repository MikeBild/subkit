import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { and, eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { closeDb } from "../../db/client.ts";
import { auditLog, credentials, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  invokeRemoteTool,
  type McpClientLike,
} from "./pool.ts";
import { seedMcpConnector } from "./test-fixtures.ts";

const fakeClient: McpClientLike = {
  async connect() {},
  async listTools() {
    return {
      tools: [
        {
          name: "acme_tool",
          description: "stub",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  },
  async callTool() {
    throw new UnauthorizedError("401 Unauthorized");
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
const _origDatabaseUrl = process.env.DATABASE_URL;

const TOKEN_VALID_UNTIL = new Date("2999-01-01T00:00:00.000Z");

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: () => fakeClient });
  ctx = await createTestDb("mcp-pool-invoke-401");
  await closeDb();
  process.env.DATABASE_URL = ctx.url;
  const cfgDir = mkdtempSync(join(tmpdir(), "sk-cfg-pool-401-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: ctx.url, NODE_ENV: "test" },
    configPathOverride: join(cfgDir, "subkit.config.json"),
  });
  await setConfigKey("server.public_base_url", "https://engine.pool401.example", { force: true });
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-pool-401", display_name: "Pool 401 Tenant" })
    .returning();
  tenantId = t!.id;
}, 30_000);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  _resetConfigForTests();
  await closeDb();
  if (_origDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = _origDatabaseUrl;
  await ctx.cleanup();
}, 30_000);

describe("pool: mid-session 401 invalidates the oauth2 token credential", () => {
  test("callTool 401 → tool error + the oauth2 token row is deleted", async () => {
    __resetMcpClientPoolForTests();

    const server = await seedMcpConnector(ctx.db, {
      tenant_id: tenantId,
      slug: "oauth401server",
      transport: "http",
      url: "https://oauth401server.acmeauth.test/mcp",
      auth: { kind: "oauth2", issuer: "https://auth.acmeauth.test" },
    });

    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: server.id,
        environment: "prod",
        mode: "oauth2",
        value: { mode: "oauth2", access_token: "stale-access-token", token_type: "Bearer" },
        oauth2_refresh_token: null,
        oauth2_expires_at: TOKEN_VALID_UNTIL,
        actor_id: null,
        source: "oauth_callback",
      },
      ctx.db,
    );

    const tokenRowsBefore = await ctx.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, tenantId),
          eq(credentials.connector_id, server.id),
          eq(credentials.mode, "oauth2"),
        ),
      );
    expect(tokenRowsBefore.length).toBe(1);

    const INVOKING_ACTOR = "00000000-0000-0000-0000-00000000a401";
    const res = await invokeRemoteTool({
      db: ctx.db,
      tenant_id: tenantId,
      actor_id: INVOKING_ACTOR,
      actor_type: "user",
      connector_id: server.id,
      connector_slug: "oauth401server",
      call: { operation: "call_tool", tool: "acme_tool", arguments: {} },
      environment: "prod",
    });

    expect(res.ok).toBe(false);

    const invokedRows = await ctx.db
      .select({ actor_id: auditLog.actor_id, result: auditLog.result })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "mcp_external_tool.invoked"),
          eq(auditLog.resource_id, server.id),
        ),
      );
    expect(invokedRows.length).toBe(1);
    expect(invokedRows[0]!.actor_id).toBe(INVOKING_ACTOR);
    expect(invokedRows[0]!.result).toBe("error");

    const tokenRowsAfter = await ctx.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, tenantId),
          eq(credentials.connector_id, server.id),
          eq(credentials.mode, "oauth2"),
        ),
      );
    expect(tokenRowsAfter.length).toBe(0);
  });
});
