import { afterAll, beforeAll, expect } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import { getConfig, setConfigKey } from "../../config/loader.ts";
import {
  type MockOAuthServer,
  startMockOAuthServer,
} from "../../credentials/oauth2/tests/mock-server.ts";
import {
  auditLog,
  connectorOauthStates,
  connectors,
  sessions,
  vaultItems,
} from "../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { now } from "../../utils/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

export let server: HttpTestServer;

export let mock: MockOAuthServer;

export let connectorId: string;

let publicBaseUrlBefore = "";

export let uuid = createDeterministicUuidFactory(0x0a17);

export async function seedStateRow(
  state: string,
  opts: { origin?: string | null; requested_scopes?: string } = {},
): Promise<void> {
  await server.db.insert(connectorOauthStates).values({
    tenant_id: server.tenantId,
    connector_id: connectorId,
    state,
    code_verifier: "",
    redirect_uri: `${server.baseUrl}/v1/oauth/callback`,
    origin: opts.origin ?? null,
    requested_scopes: opts.requested_scopes ?? null,
    expires_at: new Date(now() + 5 * 60_000),
  });
}

export async function getCredentialRow() {
  const rows = await server.db
    .select()
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.tenant_id, server.tenantId),
        eq(vaultItems.connector_id, connectorId),
        eq(vaultItems.environment, "dev"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getStateRow(state: string) {
  const rows = await server.db
    .select()
    .from(connectorOauthStates)
    .where(eq(connectorOauthStates.state, state))
    .limit(1);
  return rows[0] ?? null;
}

export async function breakConnector(opts: { enabled?: boolean } = {}): Promise<void> {
  await server.db
    .update(connectors)
    .set({
      enabled: opts.enabled ?? true,
      needs_reauth: true,
      auth_failed_at: new Date(now() - 90 * 86_400_000),
      auth_failed_reason: "credential rejected",
      circuit_state: "open",
      circuit_failure_count: 44,
      circuit_opened_at: new Date(now() - 90 * 86_400_000),
    })
    .where(eq(connectors.id, connectorId));
}

export async function getConnectorRow() {
  const [row] = await server.db.select().from(connectors).where(eq(connectors.id, connectorId));
  if (!row) throw new Error("connector row missing");
  return row;
}

export async function getConnectorApi(): Promise<Record<string, unknown>> {
  const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}`, {
    headers: { authorization: `Bearer ${server.apiKey}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

export async function auditActions(): Promise<string[]> {
  const rows = await server.db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, server.tenantId), eq(auditLog.resource_id, connectorId)));
  return rows.map((row) => row.action);
}

export async function cockpitSession(): Promise<{
  cookie: string;
  headers: Record<string, string>;
}> {
  const [session] = await server.db
    .insert(sessions)
    .values({
      tenant_id: server.tenantId,
      user_id: server.userId,
      expires_at: new Date(now() + 60 * 60_000),
      absolute_expires_at: new Date(now() + 60 * 60_000),
      last_seen_at: new Date(now()),
    })
    .returning();
  if (!session) throw new Error("browser session seed failed");
  const payload = { tenant_id: server.tenantId, user_id: server.userId, session_id: session.id };
  const cookie = browserSessionCookie(await signBrowserSession(payload));
  return {
    cookie,
    headers: {
      cookie,
      "x-subkit-csrf": await signBrowserCsrf(payload),
      "x-subkit-client": "cockpit",
    },
  };
}

export const callback = (query: string, init?: RequestInit) =>
  fetch(`${server.baseUrl}/v1/oauth/callback?${query}`, { redirect: "manual", ...init });

export const connectorPage = () => `${server.baseUrl}/cockpit/connectors/${connectorId}`;

export function setupConnectorOauth(): void {
  uuid = createDeterministicUuidFactory(0x0a17);
  publicBaseUrlBefore = "";
  beforeAll(async () => {
    server = await createHttpTestServer("oauth-callback");
    publicBaseUrlBefore = getConfig().server.public_base_url;
    await setConfigKey("server.public_base_url", server.baseUrl, { force: true });
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
    await setConfigKey("server.public_base_url", publicBaseUrlBefore, { force: true });
    await mock.close();
    await server.cleanup();
  });
}
