import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { getCredentialForConnector, upsertCredential } from "../../service.ts";
import { __resetOAuth2CacheForTests, runClientCredentialsGrant } from "../client.ts";
import { refreshIfStale } from "../refresh-worker.ts";
import { type MockOAuthServer, startMockOAuthServer } from "./mock-server.ts";

let ctx: TestDb;
let mock: MockOAuthServer;
let tenantId: string;
let connectorIdNeedsReauth: string;
let connectorIdRefreshToken: string;
let connectorIdFresh: string;

beforeAll(async () => {
  ctx = await createTestDb("oauth2_refresh_needs_reauth");
  mock = await startMockOAuthServer();
  __resetOAuth2CacheForTests();

  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "rna-tenant", display_name: "needs-reauth tenant" })
    .returning();
  tenantId = t!.id;

  const [cA] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: "rna-svc-a",
      display_name: "RNA service A",
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://example.test",
      needs_reauth: true,
      config: {
        oauth: {
          issuer_url: mock.baseUrl,
          client_id: "rna-client",
          client_secret: "rna-secret",
          scope: "read",
        },
      },
    })
    .returning();
  connectorIdNeedsReauth = cA!.id;

  const [cB] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: "rna-svc-b",
      display_name: "RNA service B (cognito)",
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://example.test",
      needs_reauth: true,
      config: {
        oauth: {
          grant_type: "cognito_user_password",
          issuer_url: mock.baseUrl,
          client_id: "rna-cognito-client",
          scope: "read",
        },
        aws_region: "us-east-1",
        cognito_username: "test-user",
      },
    })
    .returning();
  connectorIdRefreshToken = cB!.id;

  const [cC] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: "rna-svc-c",
      display_name: "RNA service C (no reauth)",
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://example.test",
      needs_reauth: false,
      config: {
        oauth: {
          issuer_url: mock.baseUrl,
          client_id: "rna-client-c",
          client_secret: "rna-secret-c",
          scope: "read",
        },
      },
    })
    .returning();
  connectorIdFresh = cC!.id;
});

afterAll(async () => {
  await mock.close();
  __resetOAuth2CacheForTests();
  await ctx.cleanup();
});

async function seedExpiredCredential(connId: string, accessToken: string) {
  const expiredAt = new Date("2000-01-01T00:00:00.000Z");
  await upsertCredential(
    {
      tenant_id: tenantId,
      connector_id: connId,
      environment: "dev",
      mode: "oauth2",
      value: {
        mode: "oauth2",
        access_token: accessToken,
        token_type: "Bearer",
      },
      oauth2_refresh_token: `rt-seed-${accessToken}`,
      oauth2_expires_at: expiredAt,
      actor_id: null,
    },
    ctx.db,
  );
  const fetched = await getCredentialForConnector(tenantId, connId, "dev", ctx.db);
  if (fetched?.value.mode !== "oauth2") {
    throw new Error("seed failed: credential not found or wrong mode");
  }
  return fetched;
}

describe("refreshIfStale — needs_reauth short-circuit", () => {
  test("short-circuits when needs_reauth=true (standard refresh_token grant): returns stale token, IdP not called", async () => {
    const issuedBefore = mock.issuedCount();
    const staleAccessToken = "stale-at-refresh-token-grant";

    const fetched = await seedExpiredCredential(connectorIdNeedsReauth, staleAccessToken);
    if (fetched.value.mode !== "oauth2") throw new Error("wrong mode");

    const result = await refreshIfStale(ctx.db, tenantId, fetched.row, fetched.value);

    expect(result.mode).toBe("oauth2");
    if (result.mode === "oauth2") {
      expect(result.access_token).toBe(staleAccessToken);
    }

    expect(mock.issuedCount()).toBe(issuedBefore);
  });

  test("short-circuits when needs_reauth=true (cognito_user_password grant): returns stale token, IdP not called", async () => {
    const issuedBefore = mock.issuedCount();
    const staleAccessToken = "stale-at-cognito-grant";

    const fetched = await seedExpiredCredential(connectorIdRefreshToken, staleAccessToken);
    if (fetched.value.mode !== "oauth2") throw new Error("wrong mode");

    const result = await refreshIfStale(ctx.db, tenantId, fetched.row, fetched.value);

    expect(result.mode).toBe("oauth2");
    if (result.mode === "oauth2") {
      expect(result.access_token).toBe(staleAccessToken);
    }

    expect(mock.issuedCount()).toBe(issuedBefore);
  });

  test("regression — needs_reauth=false still calls IdP and returns a refreshed token", async () => {
    mock.setExpiresIn(1);
    const initial = await runClientCredentialsGrant(
      {
        issuer_url: mock.baseUrl,
        client_id: "rna-client-c",
        client_secret: "rna-secret-c",
        scope: "read",
      },
      { mode: "permissive" },
    );

    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: connectorIdFresh,
        environment: "dev",
        mode: "oauth2",
        value: {
          mode: "oauth2",
          access_token: initial.access_token,
          token_type: initial.token_type,
        },
        oauth2_refresh_token: initial.refresh_token,
        oauth2_expires_at: initial.expires_at,
        actor_id: null,
      },
      ctx.db,
    );

    await new Promise((r) => setTimeout(r, 1200)); // allow-wall-clock: token-refresh skew window for the OAuth2 fixture clock
    mock.setExpiresIn(3600);

    const issuedBefore = mock.issuedCount();

    const fetched = await getCredentialForConnector(tenantId, connectorIdFresh, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    if (fetched?.value.mode !== "oauth2") throw new Error("wrong mode");

    const result = await refreshIfStale(ctx.db, tenantId, fetched.row, fetched.value);

    expect(mock.issuedCount()).toBeGreaterThan(issuedBefore);
    expect(mock.lastGrantType()).toBe("refresh_token");
    expect(result.mode).toBe("oauth2");
    if (result.mode === "oauth2") {
      expect(result.access_token).not.toBe(initial.access_token);
    }
  });
});
