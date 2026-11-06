import { afterAll, beforeAll } from "bun:test";
import { _withDriverFetchForTests } from "../../../connectors/drivers/fetch-seam.ts";
import { mcpOauthStates, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { FROZEN_NOW } from "../../../test-helpers/determinism/clock.ts";
import { withMcpCredentialObserver } from "../credential-observation.ts";
import { makeMcpOAuthProvider } from "../oauth-provider.ts";
import { seedMcpConnector } from "../test-fixtures.ts";

export let ctx: TestDb;

export let tenantA: string;

export let tenantB: string;

export const FAKE_REDIRECT_URI = "https://engine.acmeauth.test/v1/connectors/mcp/oauth/callback";

export const FAKE_SERVER_URL = "https://examplemcp.acmeauth.test/mcp";

export const FAKE_ISSUER = "https://auth.acmeauth.test";

const STATE_FAR_FUTURE = new Date("2999-01-01T00:00:00.000Z");

export const TOKEN_EXPIRED_AT = new Date(FROZEN_NOW - 120_000);

export async function seedOAuth2Server(tenantId: string, slug: string): Promise<string> {
  const row = await seedMcpConnector(ctx.db, {
    tenant_id: tenantId,
    slug,
    transport: "http",
    url: FAKE_SERVER_URL,
    auth: { kind: "oauth2", issuer: FAKE_ISSUER, scope: "read write" },
  });
  return row.id;
}

export async function seedStateRow(
  tenantId: string,
  serverId: string,
  state: string,
): Promise<void> {
  await ctx.db.insert(mcpOauthStates).values({
    tenant_id: tenantId,
    connector_id: serverId,
    state,
    code_verifier: "",
    redirect_uri: FAKE_REDIRECT_URI,
    expires_at: STATE_FAR_FUTURE,
  });
}

export function makeInteractiveProvider(tenantId: string, serverId: string, state: string) {
  return makeMcpOAuthProvider({
    db: ctx.db,
    tenant_id: tenantId,
    connector_id: serverId,
    environment: "prod",
    redirect_uri: FAKE_REDIRECT_URI,
    state,
    auth: { kind: "oauth2", issuer: FAKE_ISSUER, scope: "read write" },
    interactive: true,
    request_source: "api",
  });
}

export function makeNonInteractiveProvider(tenantId: string, serverId: string) {
  return makeMcpOAuthProvider({
    db: ctx.db,
    tenant_id: tenantId,
    connector_id: serverId,
    environment: "prod",
    redirect_uri: FAKE_REDIRECT_URI,
    state: "",
    auth: { kind: "oauth2", issuer: FAKE_ISSUER },
    interactive: false,
    request_source: "api",
  });
}

export async function observeSubject(
  provider: ReturnType<typeof makeMcpOAuthProvider>,
  token: string,
  subject: string,
  generation?: number,
): Promise<void> {
  provider.saveDiscoveryState({
    authorizationServerUrl: FAKE_ISSUER,
    authorizationServerMetadata: {
      issuer: FAKE_ISSUER,
      authorization_endpoint: `${FAKE_ISSUER}/authorize`,
      token_endpoint: `${FAKE_ISSUER}/token`,
      response_types_supported: ["code"],
    },
  });
  await provider.observeTokenResponse(
    `${FAKE_ISSUER}/token`,
    { method: "POST" },
    Response.json({ access_token: token, sub: subject }),
    generation,
  );
}

export async function saveRefreshResponse(
  provider: ReturnType<typeof makeMcpOAuthProvider>,
  tokens: Parameters<ReturnType<typeof makeMcpOAuthProvider>["saveTokens"]>[0],
): Promise<void> {
  provider.saveDiscoveryState({
    authorizationServerUrl: FAKE_ISSUER,
    authorizationServerMetadata: {
      issuer: FAKE_ISSUER,
      authorization_endpoint: `${FAKE_ISSUER}/authorize`,
      token_endpoint: `${FAKE_ISSUER}/token`,
      response_types_supported: ["code"],
    },
  });
  await withMcpCredentialObserver(undefined, async () => {
    await provider.tokens();
    const responseFetch: typeof fetch = Object.assign(async () => Response.json(tokens), {
      preconnect() {},
    });
    await _withDriverFetchForTests(responseFetch, async () => {
      const response = await provider.fetch(`${FAKE_ISSUER}/token`, { method: "POST" });
      await response.json();
    });
    await provider.saveTokens({ ...tokens, issuer: FAKE_ISSUER });
  });
}

export function setupOauthProvider(): void {
  beforeAll(async () => {
    ctx = await createTestDb("mcp-oauth-provider");

    const [a] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-oauth-a", display_name: "OAuth Provider Tenant A" })
      .returning();
    const [b] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-oauth-b", display_name: "OAuth Provider Tenant B" })
      .returning();
    tenantA = a!.id;
    tenantB = b!.id;
  }, 30_000);
  afterAll(async () => {
    await ctx.cleanup();
  }, 30_000);
}
