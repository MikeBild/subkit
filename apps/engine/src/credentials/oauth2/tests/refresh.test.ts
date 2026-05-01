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
let connectorId: string;

beforeAll(async () => {
  ctx = await createTestDb("oauth2_refresh");
  mock = await startMockOAuthServer();
  __resetOAuth2CacheForTests();
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "rt", display_name: "refresh tenant" })
    .returning();
  tenantId = t!.id;
  const [c] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: "rt-svc",
      display_name: "RT service",
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://example.test",
      // resolveConnectorOAuthConfig (template-binding.ts) reads
      // `config.oauth.*`, not the top-level config keys. The test
      // setup originally put issuer_url / client_id / etc. at the
      // top level — refresh-worker found no oauth config + skipped
      // the refresh + the assertion that the access_token rotated
      // failed. Nest the block correctly.
      config: {
        oauth: {
          issuer_url: mock.baseUrl,
          client_id: "rt-client",
          client_secret: "rt-secret",
          scope: "read",
        },
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

describe("oauth2 refresh", () => {
  test("stale token is refreshed inline and replaced in the db", async () => {
    // Issue a short-lived token (1s) via client credentials.
    mock.setExpiresIn(1);
    const initial = await runClientCredentialsGrant({
      issuer_url: mock.baseUrl,
      client_id: "rt-client",
      client_secret: "rt-secret",
      scope: "read",
    });
    expect(initial.refresh_token).toBeTruthy();

    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
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
    const issuedBefore = mock.issuedCount();

    // Wait past expiry; any read after this should trigger refresh.
    await new Promise((r) => setTimeout(r, 1200)); // allow-wall-clock: legacy; review before changing

    // Reset the mock's expires_in to a long window so the refreshed
    // token doesn't also immediately expire.
    mock.setExpiresIn(3600);

    const fetched = await getCredentialForConnector(tenantId, connectorId, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    if (fetched!.value.mode !== "oauth2") throw new Error("wrong mode");
    const stale = fetched!.value;
    const refreshed = await refreshIfStale(ctx.db, tenantId, fetched!.row, stale);
    expect(refreshed.mode).toBe("oauth2");
    if (refreshed.mode === "oauth2") {
      expect(refreshed.access_token).not.toBe(initial.access_token);
    }
    expect(mock.issuedCount()).toBeGreaterThan(issuedBefore);
    expect(mock.lastGrantType()).toBe("refresh_token");

    // Persisted row has the new access token.
    const persisted = await getCredentialForConnector(tenantId, connectorId, "dev", ctx.db);
    if (persisted!.value.mode === "oauth2") {
      expect(persisted!.value.access_token).not.toBe(initial.access_token);
    }
  });
});
