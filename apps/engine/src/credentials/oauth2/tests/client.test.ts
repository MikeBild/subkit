import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectors, tenants, vaultItems } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { upsertCredential } from "../../service.ts";
import { __resetOAuth2CacheForTests, runClientCredentialsGrant } from "../client.ts";
import { type MockOAuthServer, startMockOAuthServer } from "./mock-server.ts";

let ctx: TestDb;
let mock: MockOAuthServer;
let tenantId: string;
let connectorId: string;

beforeAll(async () => {
  ctx = await createTestDb("oauth2_client");
  mock = await startMockOAuthServer();
  __resetOAuth2CacheForTests();
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "oat", display_name: "OAuth Tenant" })
    .returning();
  tenantId = t!.id;
  const [c] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: "oa-svc",
      display_name: "OAuth Service",
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://example.test",
      config: {
        issuer_url: mock.baseUrl,
        client_id: "test-client",
        client_secret: "test-secret",
        scope: "read",
      },
    })
    .returning();
  connectorId = c!.id;
});

afterAll(async () => {
  await mock.close();
  __resetOAuth2CacheForTests();
  await ctx.cleanup();
});

describe("oauth2 client-credentials grant + encrypted storage", () => {
  test("token is stored encrypted, ciphertext differs from plaintext", async () => {
    const bundle = await runClientCredentialsGrant(
      {
        issuer_url: mock.baseUrl,
        client_id: "test-client",
        client_secret: "test-secret",
        scope: "read",
      },
      { mode: "permissive" },
    );
    expect(bundle.access_token).toMatch(/^at-/);
    expect(bundle.refresh_token).toMatch(/^rt-/);
    expect(mock.lastGrantType()).toBe("client_credentials");

    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        environment: "dev",
        mode: "oauth2",
        value: {
          mode: "oauth2",
          access_token: bundle.access_token,
          token_type: bundle.token_type,
          ...(bundle.scope ? { scope: bundle.scope } : {}),
        },
        oauth2_refresh_token: bundle.refresh_token,
        oauth2_expires_at: bundle.expires_at,
        actor_id: null,
      },
      ctx.db,
    );

    const rows = await ctx.db
      .select()
      .from(vaultItems)
      .where(eq(vaultItems.connector_id, connectorId));
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    const hex = Buffer.from(row.ciphertext).toString("hex");
    const accessHex = Buffer.from(bundle.access_token, "utf8").toString("hex");
    expect(hex.includes(accessHex)).toBe(false);
    if (row.oauth2_refresh_ciphertext) {
      const refreshHex = Buffer.from(row.oauth2_refresh_ciphertext).toString("hex");
      const plainRefreshHex = Buffer.from(bundle.refresh_token ?? "", "utf8").toString("hex");
      expect(refreshHex.includes(plainRefreshHex)).toBe(false);
    }
  });
});
