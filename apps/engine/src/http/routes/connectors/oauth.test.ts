// Integration tests for the global OAuth2 callback route.
//
// Covers the v4.7.3 refactor: a single unauthenticated
// `GET /v1/oauth/callback` looks up the connector by opaque `state`
// (atomically claimed via DELETE … RETURNING), exchanges the code at
// the OAuth provider, and persists the credential under the state
// row's tenant_id / connector_id. State encodes everything the
// callback needs; the callback URL is connector-agnostic.
//
// What the tests pin:
//   1. happy path — valid state + code → credential row written,
//      state row deleted, HTML success page returned.
//   2. provider error — `?error=access_denied` returns HTML error
//      page (200/400 with text/html, not JSON), state row deleted.
//   3. state replay — second GET with the same state returns the
//      "state not found" page (the first call atomically claimed
//      the row).
//   4. unknown state — random state value returns the same
//      not-found page (no leakage of valid-state-but-wrong-tenant).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  type MockOAuthServer,
  startMockOAuthServer,
} from "../../../credentials/oauth2/tests/mock-server.ts";
import { connectorOauthStates, connectors, credentials, events } from "../../../db/schema/index.ts";
import { now } from "../../../utils/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let mock: MockOAuthServer;
let connectorId: string;

beforeAll(async () => {
  server = await createHttpTestServer("oauth-callback");
  mock = await startMockOAuthServer();
  const [row] = await server.db
    .insert(connectors)
    .values({
      tenant_id: server.tenantId,
      slug: "mock-oauth-svc",
      display_name: "Mock OAuth service",
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://mock-oauth.test",
      config: {
        oauth: {
          issuer_url: mock.baseUrl,
          authorization_endpoint: `${mock.baseUrl}/authorize`,
          token_endpoint: `${mock.baseUrl}/token`,
          client_id: "test-client",
          client_secret: "test-secret",
          scope: "read",
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

async function seedStateRow(state: string, code_verifier = ""): Promise<void> {
  await server.db.insert(connectorOauthStates).values({
    tenant_id: server.tenantId,
    connector_id: connectorId,
    state,
    code_verifier,
    redirect_uri: `${server.baseUrl}/v1/oauth/callback`,
    // The callback route checks `expires_at > now()`; use the
    // production clock seam (not `Date.now`) so the determinism gate
    // is happy AND tests that install `setTestNow` still observe the
    // same wall.
    expires_at: new Date(now() + 5 * 60_000),
  });
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

async function getStateRow(state: string) {
  const rows = await server.db
    .select()
    .from(connectorOauthStates)
    .where(eq(connectorOauthStates.state, state))
    .limit(1);
  return rows[0] ?? null;
}

describe("GET /v1/oauth/callback", () => {
  test("happy path persists the credential and deletes the state row", async () => {
    const state = "state-happy-path-1";
    await seedStateRow(state);
    const code = "test-code-stub";
    const res = await fetch(`${server.baseUrl}/v1/oauth/callback?state=${state}&code=${code}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const body = await res.text();
    expect(body).toContain("Authentication complete");

    const cred = await getCredentialRow();
    expect(cred).not.toBeNull();
    expect(cred!.mode).toBe("oauth2");

    expect(await getStateRow(state)).toBeNull();

    // v4.8.0 Fix #1: callback must also publish
    // `connector.oauth.callback_succeeded` on the `connector.oauth`
    // channel so sk-cli can auto-resume the in-flight conversation.
    // Assert the events row exists with the documented payload shape.
    const eventRows = await server.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.tenant_id, server.tenantId),
          eq(events.channel, "connector.oauth"),
          eq(events.type, "connector.oauth.callback_succeeded"),
        ),
      );
    expect(eventRows.length).toBe(1);
    const payload = eventRows[0]!.payload as Record<string, unknown>;
    expect(payload.connector_id).toBe(connectorId);
    expect(payload.source).toBe("oauth_callback");
    expect(typeof payload.connector_slug).toBe("string");
    expect(typeof payload.has_refresh_token).toBe("boolean");
  });

  test("provider error returns an HTML error page and deletes the state row", async () => {
    const state = "state-provider-error";
    await seedStateRow(state);
    const res = await fetch(
      `${server.baseUrl}/v1/oauth/callback?state=${state}&error=access_denied&error_description=user+denied`,
    );
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("user denied");
    expect(await getStateRow(state)).toBeNull();
  });

  test("state replay: second callback with the same state returns the not-found page", async () => {
    const state = "state-replay";
    await seedStateRow(state);
    const code = "test-code-stub";
    // First call wins (DELETE … RETURNING atomically claims the row).
    const first = await fetch(`${server.baseUrl}/v1/oauth/callback?state=${state}&code=${code}`);
    expect(first.status).toBe(200);
    // Second call sees no row — should render the "state not found" page.
    const second = await fetch(`${server.baseUrl}/v1/oauth/callback?state=${state}&code=ignored`);
    expect(second.status).toBe(400);
    expect(second.headers.get("content-type")).toMatch(/^text\/html/);
    const body = await second.text();
    expect(body).toContain("OAuth state not found");
  });

  test("unknown state returns the same not-found page (no state leakage)", async () => {
    const res = await fetch(`${server.baseUrl}/v1/oauth/callback?state=does-not-exist&code=x`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("OAuth state not found");
  });
});
