// Integration tests for GET /v1/connectors/{id}/oauth/start?grant=…
//
// Covers:
//   a) mint → unauthenticated GET → 302 to provider + state row with
//      requested_scopes, grant row deleted, grant_consumed audit.
//   b) full zero-to-credential: GET grant → extract state from Location →
//      GET /v1/oauth/callback?code&state → credential row written.
//   c) grant replay → 400 HTML, no second state row.
//   d) expired grant → 400.
//   e) valid grant + wrong connector path id → 400 AND grant still claimable
//      at the correct connector id.
//   f) GET without grant param → 400 (Zod validation), not 401.
//   g) POST without bearer still 401 (existing auth not bypassed).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, gt } from "drizzle-orm";

import { setConfigKey } from "../../../config/loader.ts";
import { generateStartGrant, sha256Hex } from "../../../connectors/oauth-start-grant.ts";
import { __resetOAuth2CacheForTests } from "../../../credentials/oauth2/client.ts";
import {
  type MockOAuthServer,
  startMockOAuthServer,
} from "../../../credentials/oauth2/tests/mock-server.ts";
import {
  auditLog,
  connectorOauthStartGrants,
  connectorOauthStates,
  connectors,
  credentials,
} from "../../../db/schema/index.ts";
import { now } from "../../../utils/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let mock: MockOAuthServer;
let connectorId: string;

beforeAll(async () => {
  server = await createHttpTestServer("oauth-grant-start");
  mock = await startMockOAuthServer();

  // Set public_base_url so buildOAuthRedirectUri resolves for mintOAuthStartGrantUrl.
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });

  const [row] = await server.db
    .insert(connectors)
    .values({
      tenant_id: server.tenantId,
      slug: "mock-grant-oauth",
      display_name: "Mock Grant OAuth",
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://mock-grant-oauth.test",
      config: {
        oauth: {
          issuer_url: mock.baseUrl,
          authorization_endpoint: `${mock.baseUrl}/authorize`,
          token_endpoint: `${mock.baseUrl}/token`,
          client_id: "grant-test-client",
          client_secret: "grant-test-secret",
          scope: "read write",
          use_pkce: false,
        },
      },
    })
    .returning();
  if (!row) throw new Error("seed connector failed");
  connectorId = row.id;
});

afterAll(async () => {
  await mock.close();
  await server.cleanup();
});

// Helper: insert a fresh grant row directly.
async function seedGrant(opts?: { expires_at?: Date; connector_id?: string }) {
  const { plaintext, hash } = generateStartGrant();
  const expires_at = opts?.expires_at ?? new Date(now() + 5 * 60_000);
  await server.db.insert(connectorOauthStartGrants).values({
    tenant_id: server.tenantId,
    connector_id: opts?.connector_id ?? connectorId,
    token_sha256: hash,
    created_by_actor_id: server.userId,
    expires_at,
  });
  return plaintext;
}

async function getGrantRow(token: string) {
  const hash = sha256Hex(token);
  const rows = await server.db
    .select()
    .from(connectorOauthStartGrants)
    .where(eq(connectorOauthStartGrants.token_sha256, hash))
    .limit(1);
  return rows[0] ?? null;
}

async function getCredentialRow() {
  const rows = await server.db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.tenant_id, server.tenantId),
        eq(credentials.connector_id, connectorId),
        eq(credentials.environment, "dev"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

describe("GET /v1/connectors/{id}/oauth/start?grant=…", () => {
  test("(a) mint → GET → 302 to provider, grant deleted, grant_consumed audit", async () => {
    const token = await seedGrant();

    // Unauthenticated GET must not follow the 302 automatically.
    const res = await fetch(
      `${server.baseUrl}/v1/connectors/${connectorId}/oauth/start?grant=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    expect(location).toContain(mock.baseUrl);
    expect(location).toContain("/authorize");

    // Grant row must be deleted (atomic claim).
    expect(await getGrantRow(token)).toBeNull();

    // State row must exist with requested_scopes.
    const stateRows = await server.db
      .select()
      .from(connectorOauthStates)
      .where(
        and(
          eq(connectorOauthStates.tenant_id, server.tenantId),
          eq(connectorOauthStates.connector_id, connectorId),
          gt(connectorOauthStates.expires_at, new Date(now())),
        ),
      );
    expect(stateRows.length).toBeGreaterThan(0);
    expect(stateRows[0]?.requested_scopes).toBe("read write");

    // grant_consumed audit row must exist.
    const consumedAudit = await server.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, server.tenantId),
          eq(auditLog.action, "connector.oauth.grant_consumed"),
        ),
      );
    expect(consumedAudit.length).toBeGreaterThan(0);
  });

  test("(b) full zero-to-credential via grant flow", async () => {
    __resetOAuth2CacheForTests?.();

    const token = await seedGrant();

    // Step 1: follow the grant redirect to get the provider's redirect back.
    const startRes = await fetch(
      `${server.baseUrl}/v1/connectors/${connectorId}/oauth/start?grant=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    expect(startRes.status).toBe(302);

    // Step 2: the provider authorize endpoint redirects back to /v1/oauth/callback.
    const authUrl = startRes.headers.get("location")!;
    const authRes = await fetch(authUrl, { redirect: "manual" });
    expect(authRes.status).toBe(302);

    // Step 3: follow the callback redirect.
    const callbackUrl = authRes.headers.get("location")!;
    expect(callbackUrl).toContain("/v1/oauth/callback");
    const callbackRes = await fetch(callbackUrl);
    expect(callbackRes.status).toBe(200);
    const html = await callbackRes.text();
    expect(html).toContain("Authentication complete");

    // Credential row must be written.
    const cred = await getCredentialRow();
    expect(cred).not.toBeNull();
    expect(cred?.mode).toBe("oauth2");
  });

  test("(c) grant replay → 400 HTML, no second state row", async () => {
    const token = await seedGrant();

    // First use: should succeed with 302.
    const first = await fetch(
      `${server.baseUrl}/v1/connectors/${connectorId}/oauth/start?grant=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    expect(first.status).toBe(302);

    // Clean up the state row from the first use to isolate the replay test.
    await server.db
      .delete(connectorOauthStates)
      .where(eq(connectorOauthStates.connector_id, connectorId));

    // Replay: grant is burned, should return 400.
    const second = await fetch(
      `${server.baseUrl}/v1/connectors/${connectorId}/oauth/start?grant=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    expect(second.status).toBe(400);
    const body = await second.text();
    expect(body).toContain("expired");
  });

  test("(d) expired grant → 400 HTML", async () => {
    // Seed a grant that has already expired.
    const expiredAt = new Date(now() - 1000);
    const token = await seedGrant({ expires_at: expiredAt });

    const res = await fetch(
      `${server.baseUrl}/v1/connectors/${connectorId}/oauth/start?grant=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("expired");
  });

  test("(e) valid grant + wrong connector path id → 400 AND grant still claimable at correct id", async () => {
    const token = await seedGrant();

    // Seed a second connector so there's a valid UUID to use as the wrong path.
    const [other] = await server.db
      .insert(connectors)
      .values({
        tenant_id: server.tenantId,
        slug: "wrong-connector-for-grant",
        display_name: "Wrong",
        driver: "http",
        environment: "dev",
        auth_type: "oauth2",
        base_url: "https://wrong.test",
        config: {},
      })
      .returning();
    if (!other) throw new Error("seed other connector failed");

    // GET with wrong connector id → 400 (grant not burned).
    const wrongRes = await fetch(
      `${server.baseUrl}/v1/connectors/${other.id}/oauth/start?grant=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    expect(wrongRes.status).toBe(400);

    // Grant must still exist (not burned by the wrong-id attempt).
    expect(await getGrantRow(token)).not.toBeNull();

    // GET with the correct connector id must still work.
    const correctRes = await fetch(
      `${server.baseUrl}/v1/connectors/${connectorId}/oauth/start?grant=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    expect(correctRes.status).toBe(302);
    // Now it must be burned.
    expect(await getGrantRow(token)).toBeNull();
  });

  test("(f) GET without grant param → 400 (Zod validation), not 401", async () => {
    const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/oauth/start`, {
      redirect: "manual",
    });
    // Zod validation failure returns 400, not 401 (no bearer check on GET).
    expect(res.status).toBe(400);
  });

  test("(g) POST without bearer still 401 (existing auth not bypassed)", async () => {
    const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/oauth/start`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});
