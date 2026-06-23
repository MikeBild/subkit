// Tests the short-circuit guard added to refreshIfStale:
// when connector.needs_reauth === true, a stale credential is returned
// unchanged and the IdP is never contacted.
//
// Mirrors the harness in refresh.test.ts exactly — same DB setup,
// same mock OAuth server, same upsertCredential + getCredentialForConnector
// helpers, same __resetOAuth2CacheForTests guard.

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
// One connector per grant type so the tests are independent.
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

  // Connector A — needs_reauth=true, standard refresh_token grant (matches
  // the existing refresh.test.ts style).
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

  // Connector B — needs_reauth=true, grant type cognito_user_password so the
  // test covers that the short-circuit fires before any grant-type dispatch.
  // We stash a fake aws_region inside config; the guard fires before the
  // Cognito path is reached, so the value never matters.
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

  // Connector C — needs_reauth=false; used for the regression test that
  // proves the guard doesn't fire when the flag is cleared.
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

// ---------------------------------------------------------------------------
// Helper — seed an expired oauth2 credential for a given connector.
// Returns the decrypted credential value and the db row as returned by
// getCredentialForConnector, exactly as refresh.test.ts does it.
// ---------------------------------------------------------------------------
async function seedExpiredCredential(connId: string, accessToken: string) {
  // expires_at in the past so refreshIfStale considers the token stale.
  const expiredAt = new Date(Date.now() - 5_000);
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
  if (!fetched || fetched.value.mode !== "oauth2") {
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

    // Must return the same stale access token — not a refreshed one.
    expect(result.mode).toBe("oauth2");
    if (result.mode === "oauth2") {
      expect(result.access_token).toBe(staleAccessToken);
    }

    // The mock IdP must NOT have been called.
    expect(mock.issuedCount()).toBe(issuedBefore);
  });

  test("short-circuits when needs_reauth=true (cognito_user_password grant): returns stale token, IdP not called", async () => {
    // For the cognito grant type the connector needs aws_region + cognito_username
    // to reach the branch; however the needs_reauth guard fires BEFORE
    // grant-type dispatch, so those fields don't matter.
    const issuedBefore = mock.issuedCount();
    const staleAccessToken = "stale-at-cognito-grant";

    const fetched = await seedExpiredCredential(connectorIdRefreshToken, staleAccessToken);
    if (fetched.value.mode !== "oauth2") throw new Error("wrong mode");

    const result = await refreshIfStale(ctx.db, tenantId, fetched.row, fetched.value);

    expect(result.mode).toBe("oauth2");
    if (result.mode === "oauth2") {
      expect(result.access_token).toBe(staleAccessToken);
    }

    // IdP still not called — regardless of grant type.
    expect(mock.issuedCount()).toBe(issuedBefore);
  });

  test("regression — needs_reauth=false still calls IdP and returns a refreshed token", async () => {
    // Seed a long-lived token for the initial client_credentials round so
    // the refresh mock can issue a fresh token with a proper expires_in.
    mock.setExpiresIn(1);
    const initial = await runClientCredentialsGrant({
      issuer_url: mock.baseUrl,
      client_id: "rna-client-c",
      client_secret: "rna-secret-c",
      scope: "read",
    });

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

    // Wait past the 1 s expiry window.
    await new Promise((r) => setTimeout(r, 1200)); // allow-wall-clock: token-refresh skew window for the OAuth2 fixture clock
    mock.setExpiresIn(3600);

    const issuedBefore = mock.issuedCount();

    const fetched = await getCredentialForConnector(tenantId, connectorIdFresh, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    if (!fetched || fetched.value.mode !== "oauth2") throw new Error("wrong mode");

    const result = await refreshIfStale(ctx.db, tenantId, fetched.row, fetched.value);

    // The IdP was called and a new access token was returned.
    expect(mock.issuedCount()).toBeGreaterThan(issuedBefore);
    expect(mock.lastGrantType()).toBe("refresh_token");
    expect(result.mode).toBe("oauth2");
    if (result.mode === "oauth2") {
      expect(result.access_token).not.toBe(initial.access_token);
    }
  });
});
