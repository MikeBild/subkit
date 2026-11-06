import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { credentials, mcpOauthStates } from "../../db/schema/index.ts";
import { makeMcpOAuthProvider } from "./oauth-provider.ts";
import {
  ctx,
  FAKE_ISSUER,
  FAKE_REDIRECT_URI,
  makeInteractiveProvider,
  makeNonInteractiveProvider,
  seedOAuth2Server,
  seedStateRow,
  setupOauthProvider,
  tenantA,
  tenantB,
} from "./tests/oauth-provider-fixtures.ts";

setupOauthProvider();

describe("McpDbOAuthClientProvider.redirectToAuthorization", () => {
  test("interactive: persists authorization_url to the state row", async () => {
    const serverId = await seedOAuth2Server(tenantA, "redirect1");
    const state = "state-redirect1";
    await seedStateRow(tenantA, serverId, state);
    const provider = makeInteractiveProvider(tenantA, serverId, state);

    const authUrl = new URL(
      "https://auth.acmeauth.test/authorize?response_type=code&client_id=abc&state=opaque",
    );
    await provider.redirectToAuthorization(authUrl);

    const rows = await ctx.db
      .select({
        authorization_url: mcpOauthStates.authorization_url,
        as_issuer: mcpOauthStates.as_issuer,
      })
      .from(mcpOauthStates)
      .where(and(eq(mcpOauthStates.tenant_id, tenantA), eq(mcpOauthStates.state, state)))
      .limit(1);
    expect(rows[0]!.authorization_url).toBe(authUrl.toString());
    expect(rows[0]!.as_issuer).toBe("https://auth.acmeauth.test");
  });

  test("non-interactive: redirectToAuthorization is a NO-OP — authorization_url stays null", async () => {
    const serverId = await seedOAuth2Server(tenantA, "redirect2");
    const state = "state-redirect2";
    await seedStateRow(tenantA, serverId, state);

    const provider = makeNonInteractiveProvider(tenantA, serverId);
    const authUrl = new URL("https://auth.acmeauth.test/authorize?client_id=abc");
    await provider.redirectToAuthorization(authUrl);

    const rows = await ctx.db
      .select({ authorization_url: mcpOauthStates.authorization_url })
      .from(mcpOauthStates)
      .where(and(eq(mcpOauthStates.tenant_id, tenantA), eq(mcpOauthStates.state, state)))
      .limit(1);
    expect(rows[0]!.authorization_url).toBeNull();
  });
});

describe("McpDbOAuthClientProvider.invalidateCredentials", () => {
  test("'tokens' scope removes the oauth2 credential row", async () => {
    const serverId = await seedOAuth2Server(tenantA, "inval1");
    const provider = makeInteractiveProvider(tenantA, serverId, "state-inval1");

    await provider.saveTokens({
      issuer: FAKE_ISSUER,
      access_token: "tok-to-remove",
      token_type: "Bearer",
    });

    const beforeRows = await ctx.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, tenantA),
          eq(credentials.connector_id, serverId),
          eq(credentials.mode, "oauth2"),
        ),
      );
    expect(beforeRows.length).toBe(1);

    await provider.invalidateCredentials("tokens");

    const afterRows = await ctx.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, tenantA),
          eq(credentials.connector_id, serverId),
          eq(credentials.mode, "oauth2"),
        ),
      );
    expect(afterRows.length).toBe(0);
  });

  test("'client' scope removes the oauth2_client credential row and clears auth_config.client_id", async () => {
    const serverId = await seedOAuth2Server(tenantA, "inval2");
    const provider = makeInteractiveProvider(tenantA, serverId, "state-inval2");

    await provider.saveClientInformation({
      issuer: FAKE_ISSUER,
      client_id: "client-to-remove",
      client_secret: "secret-to-remove",
    });

    const beforeRows = await ctx.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, tenantA),
          eq(credentials.connector_id, serverId),
          eq(credentials.mode, "oauth2_client"),
        ),
      );
    expect(beforeRows.length).toBe(1);

    await provider.invalidateCredentials("client");

    const afterRows = await ctx.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, tenantA),
          eq(credentials.connector_id, serverId),
          eq(credentials.mode, "oauth2_client"),
        ),
      );
    expect(afterRows.length).toBe(0);

    const { connectors } = await import("../../db/schema/index.ts");
    const serverRows = await ctx.db
      .select({ config: connectors.config })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantA), eq(connectors.id, serverId)))
      .limit(1);
    const authConfig = (serverRows[0]!.config as { mcp?: { auth?: Record<string, unknown> } }).mcp
      ?.auth;
    expect(authConfig?.client_id).toBeUndefined();
  });

  test("'verifier' scope clears code_verifier on the state row", async () => {
    const serverId = await seedOAuth2Server(tenantA, "inval3");
    const state = "state-inval3";
    await seedStateRow(tenantA, serverId, state);
    const provider = makeInteractiveProvider(tenantA, serverId, state);

    await provider.saveCodeVerifier("pkce-to-clear");
    await provider.invalidateCredentials("verifier");

    const rows = await ctx.db
      .select({ code_verifier: mcpOauthStates.code_verifier })
      .from(mcpOauthStates)
      .where(and(eq(mcpOauthStates.tenant_id, tenantA), eq(mcpOauthStates.state, state)))
      .limit(1);
    expect(rows[0]!.code_verifier).toBe("");
  });
});

describe("McpDbOAuthClientProvider tenant isolation", () => {
  test("tenant A's provider cannot read tenant B's tokens", async () => {
    const serverIdB = await seedOAuth2Server(tenantB, "isolate1");
    const providerB = makeMcpOAuthProvider({
      db: ctx.db,
      tenant_id: tenantB,
      connector_id: serverIdB,
      environment: "prod",
      redirect_uri: FAKE_REDIRECT_URI,
      state: "state-iso-b",
      auth: { kind: "oauth2", issuer: FAKE_ISSUER },
      interactive: true,
      request_source: "api",
    });
    await providerB.saveTokens({
      issuer: FAKE_ISSUER,
      access_token: "b-only-token",
      token_type: "Bearer",
    });

    const serverIdA = await seedOAuth2Server(tenantA, "isolate1");
    const providerA = makeMcpOAuthProvider({
      db: ctx.db,
      tenant_id: tenantA,
      connector_id: serverIdA,
      environment: "prod",
      redirect_uri: FAKE_REDIRECT_URI,
      state: "state-iso-a",
      auth: { kind: "oauth2", issuer: FAKE_ISSUER },
      interactive: true,
      request_source: "api",
    });

    const aTokens = await providerA.tokens();
    expect(aTokens).toBeUndefined();
  });

  test("tenant A's provider cannot read tenant B's client credentials", async () => {
    const serverIdB = await seedOAuth2Server(tenantB, "isolateclient1");
    const providerB = makeMcpOAuthProvider({
      db: ctx.db,
      tenant_id: tenantB,
      connector_id: serverIdB,
      environment: "prod",
      redirect_uri: FAKE_REDIRECT_URI,
      state: "state-iso-client-b",
      auth: { kind: "oauth2", issuer: FAKE_ISSUER },
      interactive: true,
      request_source: "api",
    });
    await providerB.saveClientInformation({ issuer: FAKE_ISSUER, client_id: "b-client-id" });

    const serverIdA = await seedOAuth2Server(tenantA, "isolateclient1");
    const providerA = makeMcpOAuthProvider({
      db: ctx.db,
      tenant_id: tenantA,
      connector_id: serverIdA,
      environment: "prod",
      redirect_uri: FAKE_REDIRECT_URI,
      state: "state-iso-client-a",
      auth: { kind: "oauth2", issuer: FAKE_ISSUER },
      interactive: true,
      request_source: "api",
    });

    const aInfo = await providerA.clientInformation();
    expect(aInfo).toBeUndefined();
  });
});
