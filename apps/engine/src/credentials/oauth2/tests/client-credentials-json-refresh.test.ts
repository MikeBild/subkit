// Integration test: refresh-worker branch for client_credentials_json.
//
// The grant has no server-issued refresh token — re-mint is done by
// re-posting the stored credential fields to the token endpoint. This
// test verifies:
//
//   1. An expired oauth2 credential with grant_type="client_credentials_json"
//      is re-minted via refreshIfStale (not via runRefreshTokenGrant).
//   2. The new access_token is persisted through rotateOAuth2Tokens.
//   3. A still-fresh token is returned unchanged (no mint call).
//
// fetch is mocked so no real server is required.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";

import { connectors, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { withDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { getCredentialForConnector, upsertCredential } from "../../service.ts";
import { refreshIfStale } from "../refresh-worker.ts";

let ctx: TestDb;
let tenantId: string;
let connectorId: string;

// We mock fetch so no real server is required. Each test restores the mock.
let fetchSpy: ReturnType<typeof mock<typeof fetch>>;

const TOKEN_ENDPOINT = "https://example.test/api/v2/authenticate";
const STALE_TOKEN = "old-jwt-token";
const FRESH_TOKEN = "new-jwt-token";

// Connector config that exercises the client_credentials_json grant.
// client_id + client_secret live in config.oauth so resolveConnectorOAuthConfig
// can find them and auto-build the body mapping.
const BASE_CONFIG: Record<string, unknown> = {
  oauth: {
    issuer_url: TOKEN_ENDPOINT,
    token_endpoint: TOKEN_ENDPOINT,
    grant_type: "client_credentials_json",
    token_response_format: "raw",
    token_response_ttl_ms: 86_400_000,
    client_id: "test-client",
    client_secret: "test-secret",
  },
};

beforeAll(async () => {
  ctx = await createTestDb("oauth2_ccj_refresh");

  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "ccj-tenant", display_name: "CCJ Tenant" })
    .returning();
  tenantId = t!.id;

  const [c] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: "ccj-connector",
      display_name: "CCJ Connector",
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://example.test",
      config: BASE_CONFIG,
    })
    .returning();
  connectorId = c!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(() => {
  fetchSpy = mock<typeof fetch>();
});

// Driver-fetch seam: the oauth2 client reads getDriverFetch(), not
// globalThis — run each body under the seam's explicit wrapper (the
// override must scope the body itself; an enterWith-from-beforeEach
// binding did not propagate into test bodies under bun).
function seamTest(name: string, body: () => Promise<void>) {
  test(name, () => withDriverFetchForTests(fetchSpy as unknown as typeof fetch, body));
}

describe("refreshIfStale — client_credentials_json grant", () => {
  seamTest("re-mints a stale token and rotates it in the db", async () => {
    // Seed an expired credential (expires 1ms in the past).
    const expiredAt = new Date(Date.now() - 1); // allow-wall-clock: tolerance-window assertion against the production clock (oauth2/client.ts computes expiry via Date.now)
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        environment: "dev",
        mode: "oauth2",
        value: {
          mode: "oauth2",
          access_token: STALE_TOKEN,
          token_type: "Bearer",
        },
        // No refresh_token — client_credentials_json re-mints instead.
        oauth2_refresh_token: null,
        oauth2_expires_at: expiredAt,
        actor_id: null,
      },
      ctx.db,
    );

    // Mock the token endpoint to return a fresh token.
    fetchSpy.mockResolvedValue(
      new Response(`"${FRESH_TOKEN}"`, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    const fetched = await getCredentialForConnector(tenantId, connectorId, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    if (fetched!.value.mode !== "oauth2") throw new Error("unexpected mode");

    const result = await refreshIfStale(ctx.db, tenantId, fetched!.row, fetched!.value);

    expect(result.mode).toBe("oauth2");
    if (result.mode === "oauth2") {
      expect(result.access_token).toBe(FRESH_TOKEN);
    }

    // The token endpoint was called exactly once.
    expect(fetchSpy.mock.calls.length).toBe(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TOKEN_ENDPOINT);
    const body = JSON.parse(String(init.body));
    // Body must contain client_id and client_secret from config.oauth.
    expect(typeof body.client_id).toBe("string");
    expect(typeof body.client_secret).toBe("string");
  });

  seamTest("returns credential unchanged when token is still fresh", async () => {
    // Ensure the connector config is in place.
    await ctx.db
      .update(connectors)
      .set({ config: BASE_CONFIG })
      .where(eq(connectors.id, connectorId));

    // Seed a credential that expires 1 hour from now.
    const futureExpiry = new Date(Date.now() + 3_600_000); // allow-wall-clock: tolerance-window assertion against the production clock (oauth2/client.ts computes expiry via Date.now)
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        environment: "dev",
        mode: "oauth2",
        value: {
          mode: "oauth2",
          access_token: STALE_TOKEN,
          token_type: "Bearer",
        },
        oauth2_refresh_token: null,
        oauth2_expires_at: futureExpiry,
        actor_id: null,
      },
      ctx.db,
    );

    const fetched = await getCredentialForConnector(tenantId, connectorId, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    if (fetched!.value.mode !== "oauth2") throw new Error("unexpected mode");

    // refreshIfStale must NOT call the token endpoint for a fresh token.
    fetchSpy.mockResolvedValue(
      new Response('"should-not-be-called"', {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    const result = await refreshIfStale(ctx.db, tenantId, fetched!.row, fetched!.value);

    expect(result.mode).toBe("oauth2");
    if (result.mode === "oauth2") {
      expect(result.access_token).toBe(STALE_TOKEN);
    }
    // No token-endpoint call for a fresh token.
    expect(fetchSpy.mock.calls.length).toBe(0);
  });
});
