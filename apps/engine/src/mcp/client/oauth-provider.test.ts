import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { _withDriverFetchForTests } from "../../connectors/drivers/fetch-seam.ts";
import { credentials, mcpOauthStates, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { withMcpCredentialObserver } from "./credential-observation.ts";
import { makeMcpOAuthProvider } from "./oauth-provider.ts";
import { seedMcpConnector } from "./test-fixtures.ts";

let ctx: TestDb;
let tenantA: string;
let tenantB: string;

const FAKE_REDIRECT_URI = "https://engine.acmeauth.test/v1/connectors/mcp/oauth/callback";
const FAKE_SERVER_URL = "https://examplemcp.acmeauth.test/mcp";
const FAKE_ISSUER = "https://auth.acmeauth.test";

const STATE_FAR_FUTURE = new Date("2999-01-01T00:00:00.000Z");
const TOKEN_EXPIRED_AT = new Date(FROZEN_NOW - 120_000);

test("wire identity accepts only the discovered configured issuer token endpoint", async () => {
  for (const rejection of [
    "issuer",
    "authorization-server",
    "endpoint",
    "method",
    "failed",
    "oversized",
  ] as const) {
    const serverId = await seedOAuth2Server(tenantA, `wire-identity-${rejection}`);
    const provider = makeInteractiveProvider(tenantA, serverId, `state-${rejection}`);
    provider.saveDiscoveryState({
      authorizationServerUrl:
        rejection === "authorization-server" ? "https://other.example.test" : FAKE_ISSUER,
      authorizationServerMetadata: {
        issuer: rejection === "issuer" ? "https://other.example.test" : FAKE_ISSUER,
        authorization_endpoint: `${FAKE_ISSUER}/authorize`,
        token_endpoint: `${FAKE_ISSUER}/token`,
        response_types_supported: ["code"],
      },
    });
    await provider.observeTokenResponse(
      rejection === "endpoint" ? FAKE_SERVER_URL : `${FAKE_ISSUER}/token`,
      { method: rejection === "method" ? "GET" : "POST" },
      Response.json(
        {
          access_token: `wire-${rejection}`,
          sub: "untrusted-subject",
          ...(rejection === "oversized" ? { padding: "x".repeat(65_536) } : {}),
        },
        { status: rejection === "failed" ? 400 : 200 },
      ),
      undefined,
    );
    await provider.saveTokens({
      access_token: `wire-${rejection}`,
      token_type: "Bearer",
      ...{ sub: "untrusted-subject" },
    });
    await provider.tokens();
    expect(provider.credentialSnapshot(`wire-${rejection}`)?.identity).toBeNull();
  }
});

test("conflicting token endpoint subjects for identical token material remain unknown", async () => {
  const serverId = await seedOAuth2Server(tenantA, "wire-identity-conflict");
  const provider = makeInteractiveProvider(tenantA, serverId, "state-wire-conflict");
  provider.saveDiscoveryState({
    authorizationServerUrl: FAKE_ISSUER,
    authorizationServerMetadata: {
      issuer: FAKE_ISSUER,
      authorization_endpoint: `${FAKE_ISSUER}/authorize`,
      token_endpoint: `${FAKE_ISSUER}/token`,
      response_types_supported: ["code"],
    },
  });
  for (const subject of ["first-account", "second-account", "first-account"]) {
    await provider.observeTokenResponse(
      `${FAKE_ISSUER}/token`,
      { method: "POST" },
      Response.json({ access_token: "conflicting-wire-token", sub: subject }),
      undefined,
    );
  }
  await provider.saveTokens({ access_token: "conflicting-wire-token", token_type: "Bearer" });
  await provider.tokens();
  expect(provider.credentialSnapshot("conflicting-wire-token")?.identity).toBeNull();
});

test("a refresh response cannot acquire the identity of an intervening authorization", async () => {
  const serverId = await seedOAuth2Server(tenantA, "wire-identity-replacement");
  const interactive = makeInteractiveProvider(tenantA, serverId, "state-wire-replacement");
  await observeSubject(interactive, "old-access", "old-account");
  await interactive.saveTokens({
    access_token: "old-access",
    refresh_token: "old-refresh",
    token_type: "Bearer",
  });
  const automatic = makeNonInteractiveProvider(tenantA, serverId);
  automatic.saveDiscoveryState({
    authorizationServerUrl: FAKE_ISSUER,
    authorizationServerMetadata: {
      issuer: FAKE_ISSUER,
      authorization_endpoint: `${FAKE_ISSUER}/authorize`,
      token_endpoint: `${FAKE_ISSUER}/token`,
      response_types_supported: ["code"],
    },
  });
  await withMcpCredentialObserver(undefined, async () => {
    await automatic.tokens();
    const responseFetch: typeof fetch = Object.assign(
      async () => {
        await observeSubject(interactive, "replacement-access", "replacement-account", 1);
        await interactive.saveTokens({
          access_token: "replacement-access",
          refresh_token: "replacement-refresh",
          token_type: "Bearer",
        });
        await automatic.tokens();
        return Response.json({ access_token: "late-refresh-token", sub: "old-account" });
      },
      { preconnect() {} },
    );
    await _withDriverFetchForTests(responseFetch, async () => {
      const response = await automatic.fetch(`${FAKE_ISSUER}/token`, { method: "POST" });
      await response.json();
    });
    await expect(
      automatic.saveTokens({ access_token: "late-refresh-token", token_type: "Bearer" }),
    ).rejects.toMatchObject({ code: "credential_generation_changed" });
  });
  const tokens = await interactive.tokens();
  expect(tokens?.access_token).toBe("replacement-access");
  expect(interactive.credentialSnapshot("replacement-access")?.identity?.subject).toBe(
    "replacement-account",
  );
});

test("a rejected response cannot reuse an earlier identity for the same token bytes", async () => {
  for (const rejection of ["redirect", "oversized", "changed-discovery"] as const) {
    const serverId = await seedOAuth2Server(tenantA, `wire-reused-${rejection}`);
    const provider = makeInteractiveProvider(tenantA, serverId, `state-reused-${rejection}`);
    await observeSubject(provider, "reused-access", "old-account");
    if (rejection === "changed-discovery") {
      provider.saveDiscoveryState({ authorizationServerUrl: "https://other.example.test" });
    } else {
      const response = Response.json({
        access_token: "reused-access",
        sub: "new-account",
        ...(rejection === "oversized" ? { padding: "x".repeat(65_536) } : {}),
      });
      if (rejection === "redirect")
        Object.defineProperty(response, "url", { value: "https://other.example.test/token" });
      await provider.observeTokenResponse(
        `${FAKE_ISSUER}/token`,
        { method: "POST" },
        response,
        undefined,
      );
    }
    await provider.saveTokens({ access_token: "reused-access", token_type: "Bearer" });
    await provider.tokens();
    expect(provider.credentialSnapshot("reused-access")?.identity).toBeNull();
  }
});

async function seedOAuth2Server(tenantId: string, slug: string): Promise<string> {
  const row = await seedMcpConnector(ctx.db, {
    tenant_id: tenantId,
    slug,
    transport: "http",
    url: FAKE_SERVER_URL,
    auth: { kind: "oauth2", issuer: FAKE_ISSUER, scope: "read write" },
  });
  return row.id;
}

async function seedStateRow(tenantId: string, serverId: string, state: string): Promise<void> {
  await ctx.db.insert(mcpOauthStates).values({
    tenant_id: tenantId,
    connector_id: serverId,
    state,
    code_verifier: "",
    redirect_uri: FAKE_REDIRECT_URI,
    expires_at: STATE_FAR_FUTURE,
  });
}

function makeInteractiveProvider(tenantId: string, serverId: string, state: string) {
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

function makeNonInteractiveProvider(tenantId: string, serverId: string) {
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

async function observeSubject(
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

describe("McpDbOAuthClientProvider.clientMetadata", () => {
  test("always contains redirect_uris and grant_types", async () => {
    const serverId = await seedOAuth2Server(tenantA, "cmeta1");
    const provider = makeInteractiveProvider(tenantA, serverId, "state-meta1");
    const meta = provider.clientMetadata;
    expect(meta.redirect_uris).toEqual([FAKE_REDIRECT_URI]);
    expect(meta.grant_types).toContain("authorization_code");
    expect(meta.grant_types).toContain("refresh_token");
  });

  test("includes scope when auth_config has a scope", async () => {
    const serverId = await seedOAuth2Server(tenantA, "cmeta2");
    const provider = makeMcpOAuthProvider({
      db: ctx.db,
      tenant_id: tenantA,
      connector_id: serverId,
      environment: "prod",
      redirect_uri: FAKE_REDIRECT_URI,
      state: "state-meta2",
      auth: { kind: "oauth2", issuer: FAKE_ISSUER, scope: "read" },
      interactive: true,
      request_source: "api",
    });
    expect(provider.clientMetadata.scope).toBe("read");
  });

  test("omits scope when auth_config has no scope", async () => {
    const serverId = await seedOAuth2Server(tenantA, "cmeta3");
    const provider = makeMcpOAuthProvider({
      db: ctx.db,
      tenant_id: tenantA,
      connector_id: serverId,
      environment: "prod",
      redirect_uri: FAKE_REDIRECT_URI,
      state: "state-meta3",
      auth: { kind: "oauth2", issuer: FAKE_ISSUER },
      interactive: true,
      request_source: "api",
    });
    expect(provider.clientMetadata.scope).toBeUndefined();
  });
});

describe("McpDbOAuthClientProvider.saveClientInformation / clientInformation", () => {
  test("persists client_id to credentials oauth2_client slot + mirrors to auth_config", async () => {
    const serverId = await seedOAuth2Server(tenantA, "saveclient1");
    const provider = makeInteractiveProvider(tenantA, serverId, "state-scl1");

    await provider.saveClientInformation({
      client_id: "acme-client-001",
      client_secret: "acme-secret-shhh",
    });

    const info = await provider.clientInformation();
    expect(info).toBeDefined();
    expect(info!.client_id).toBe("acme-client-001");
    expect(info!.client_secret).toBe("acme-secret-shhh");
  });

  test("client_secret is encrypted at rest — ciphertext differs from plaintext", async () => {
    const serverId = await seedOAuth2Server(tenantA, "saveclient2");
    const provider = makeInteractiveProvider(tenantA, serverId, "state-scl2");

    await provider.saveClientInformation({
      client_id: "acme-client-002",
      client_secret: "acme-plaintext-secret-002",
    });

    const rows = await ctx.db
      .select({ ciphertext: credentials.ciphertext })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, tenantA),
          eq(credentials.connector_id, serverId),
          eq(credentials.mode, "oauth2_client"),
        ),
      )
      .limit(1);
    expect(rows.length).toBe(1);
    const storedBytes = rows[0]!.ciphertext;
    const plaintextJson = JSON.stringify({
      client_id: "acme-client-002",
      client_secret: "acme-plaintext-secret-002",
    });
    const plaintextBytes = Buffer.from(plaintextJson);
    expect(Buffer.compare(Buffer.from(storedBytes), plaintextBytes)).not.toBe(0);
    expect(Buffer.from(storedBytes).toString("utf8")).not.toContain("acme-plaintext-secret-002");
  });

  test("saveClientInformation without client_secret works (public client)", async () => {
    const serverId = await seedOAuth2Server(tenantA, "saveclient3");
    const provider = makeInteractiveProvider(tenantA, serverId, "state-scl3");

    await provider.saveClientInformation({ client_id: "acme-public-client" });

    const info = await provider.clientInformation();
    expect(info!.client_id).toBe("acme-public-client");
    expect(info!.client_secret).toBeUndefined();
  });

  test("clientInformation falls back to auth_config.client_id when no credential exists", async () => {
    const serverId = await seedOAuth2Server(tenantA, "saveclient4");
    const provider = makeMcpOAuthProvider({
      db: ctx.db,
      tenant_id: tenantA,
      connector_id: serverId,
      environment: "prod",
      redirect_uri: FAKE_REDIRECT_URI,
      state: "state-scl4",
      auth: { kind: "oauth2", issuer: FAKE_ISSUER, client_id: "preprov-client-id" },
      interactive: true,
      request_source: "api",
    });

    const info = await provider.clientInformation();
    expect(info!.client_id).toBe("preprov-client-id");
    expect(info!.client_secret).toBeUndefined();
  });

  test("clientInformation returns undefined when no credential and no auth_config.client_id", async () => {
    const serverId = await seedOAuth2Server(tenantA, "saveclient5");
    const provider = makeInteractiveProvider(tenantA, serverId, "state-scl5");

    const info = await provider.clientInformation();
    expect(info).toBeUndefined();
  });
});

describe("McpDbOAuthClientProvider.saveTokens / tokens", () => {
  test("a non-interactive handshake cannot establish a new credential", async () => {
    const serverId = await seedOAuth2Server(tenantA, "authority-no-initial-grant");
    const provider = makeNonInteractiveProvider(tenantA, serverId);
    await expect(
      provider.saveTokens({ access_token: "not-authorized", token_type: "Bearer" }),
    ).rejects.toThrow("interactive authorization required");
    expect(await provider.tokens()).toBeUndefined();
  });

  test("automatic refresh retains authority while an interactive replacement changes it", async () => {
    const serverId = await seedOAuth2Server(tenantA, "authority-refresh-binding");
    const interactive = makeInteractiveProvider(tenantA, serverId, "authority-refresh-state");
    await interactive.saveTokens({
      access_token: "original",
      refresh_token: "refresh",
      token_type: "Bearer",
      scope: "read",
    });
    const revision = async () => {
      const rows = await ctx.db
        .select({ revision: credentials.authority_revision })
        .from(credentials)
        .where(
          and(
            eq(credentials.tenant_id, tenantA),
            eq(credentials.connector_id, serverId),
            eq(credentials.mode, "oauth2"),
          ),
        );
      return rows[0]?.revision;
    };
    const automatic = makeNonInteractiveProvider(tenantA, serverId);
    await saveRefreshResponse(automatic, { access_token: "refreshed", token_type: "Bearer" });
    expect(await revision()).toBe(1);
    expect((await automatic.tokens())?.scope).toBe("read");
    await saveRefreshResponse(automatic, {
      access_token: "expanded",
      token_type: "Bearer",
      scope: "read write",
    });
    expect(await revision()).toBe(2);
    await interactive.saveTokens({
      access_token: "new-login",
      token_type: "Bearer",
      scope: "read write",
    });
    expect(await revision()).toBe(3);
  });

  test("tokens() returns undefined when no credential row exists", async () => {
    const serverId = await seedOAuth2Server(tenantA, "tokens1");
    const provider = makeInteractiveProvider(tenantA, serverId, "state-tok1");
    const t = await provider.tokens();
    expect(t).toBeUndefined();
  });

  test("saveTokens → tokens() round-trips access_token and refresh_token", async () => {
    const serverId = await seedOAuth2Server(tenantA, "tokens2");
    const provider = makeInteractiveProvider(tenantA, serverId, "state-tok2");

    const expiresIn = 3600;
    await provider.saveTokens({
      access_token: "acme-access-tok-abc",
      token_type: "Bearer",
      refresh_token: "acme-refresh-tok-abc",
      expires_in: expiresIn,
    });

    const t = await provider.tokens();
    expect(t).toBeDefined();
    expect(t!.access_token).toBe("acme-access-tok-abc");
    expect(t!.refresh_token).toBe("acme-refresh-tok-abc");
    expect(t!.expires_in).toBeGreaterThan(3500);
  });

  test("expires_in derived from oauth2_expires_at — a past expiry yields 0", async () => {
    const serverId = await seedOAuth2Server(tenantA, "tokens3");
    const provider = makeInteractiveProvider(tenantA, serverId, "state-tok3");

    await provider.saveTokens({
      access_token: "acme-access-tok-past",
      token_type: "Bearer",
      refresh_token: "acme-refresh-for-expiry-test",
      expires_in: 3600,
    });

    const rows = await ctx.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, tenantA),
          eq(credentials.connector_id, serverId),
          eq(credentials.mode, "oauth2"),
        ),
      )
      .limit(1);
    await ctx.db
      .update(credentials)
      .set({ oauth2_expires_at: TOKEN_EXPIRED_AT })
      .where(eq(credentials.id, rows[0]!.id));

    const t = await provider.tokens();
    expect(t).toBeDefined();
    expect(t!.expires_in).toBe(0);
  });

  test("past expiry with NO refresh_token → tokens() returns undefined (re-auth signal, not a doomed refresh)", async () => {
    const serverId = await seedOAuth2Server(tenantA, "tokens-norefresh");
    const provider = makeInteractiveProvider(tenantA, serverId, "state-tok-norefresh");

    await provider.saveTokens({
      access_token: "acme-access-no-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    });

    const rows = await ctx.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, tenantA),
          eq(credentials.connector_id, serverId),
          eq(credentials.mode, "oauth2"),
        ),
      )
      .limit(1);
    await ctx.db
      .update(credentials)
      .set({ oauth2_expires_at: TOKEN_EXPIRED_AT })
      .where(eq(credentials.id, rows[0]!.id));

    const t = await provider.tokens();
    expect(t).toBeUndefined();
  });

  test("saveTokens without refresh_token carries forward prior refresh_token", async () => {
    const serverId = await seedOAuth2Server(tenantA, "tokens4");
    const provider = makeInteractiveProvider(tenantA, serverId, "state-tok4");

    await provider.saveTokens({
      access_token: "acme-access-v1",
      token_type: "Bearer",
      refresh_token: "acme-refresh-v1-keeper",
      expires_in: 3600,
    });

    await provider.saveTokens({
      access_token: "acme-access-v2",
      token_type: "Bearer",
      expires_in: 7200,
    });

    const t = await provider.tokens();
    expect(t!.access_token).toBe("acme-access-v2");
    expect(t!.refresh_token).toBe("acme-refresh-v1-keeper");
  });
});

describe("McpDbOAuthClientProvider.saveCodeVerifier / codeVerifier", () => {
  test("interactive: saveCodeVerifier persists to state row; codeVerifier reads it back", async () => {
    const serverId = await seedOAuth2Server(tenantA, "verifier1");
    const state = "state-verifier1";
    await seedStateRow(tenantA, serverId, state);
    const provider = makeInteractiveProvider(tenantA, serverId, state);

    await provider.saveCodeVerifier("pkce-verifier-abc123");
    const readBack = await provider.codeVerifier();
    expect(readBack).toBe("pkce-verifier-abc123");
  });

  test("non-interactive: saveCodeVerifier is a no-op (no DB write)", async () => {
    const serverId = await seedOAuth2Server(tenantA, "verifier2");
    const provider = makeNonInteractiveProvider(tenantA, serverId);

    await expect(provider.saveCodeVerifier("some-verifier")).resolves.toBeUndefined();

    const rows = await ctx.db
      .select()
      .from(mcpOauthStates)
      .where(and(eq(mcpOauthStates.tenant_id, tenantA), eq(mcpOauthStates.connector_id, serverId)));
    expect(rows.length).toBe(0);
  });

  test("non-interactive: codeVerifier() throws (no state row)", async () => {
    const serverId = await seedOAuth2Server(tenantA, "verifier3");
    const provider = makeNonInteractiveProvider(tenantA, serverId);

    await expect(provider.codeVerifier()).rejects.toThrow();
  });

  test("interactive: codeVerifier() throws when no matching state row exists", async () => {
    const serverId = await seedOAuth2Server(tenantA, "verifier4");
    const provider = makeInteractiveProvider(tenantA, serverId, "no-such-state");

    await expect(provider.codeVerifier()).rejects.toThrow();
  });
});

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

    await provider.saveTokens({ access_token: "tok-to-remove", token_type: "Bearer" });

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
    await providerB.saveTokens({ access_token: "b-only-token", token_type: "Bearer" });

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
    await providerB.saveClientInformation({ client_id: "b-client-id" });

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

test("identical token material across generations loses ambiguous session attribution", async () => {
  const serverId = await seedOAuth2Server(tenantA, "identity-collision");
  const interactive = makeInteractiveProvider(tenantA, serverId, "identity-collision-state");
  await observeSubject(interactive, "same-token", "first-account");
  await interactive.saveTokens({
    access_token: "same-token",
    refresh_token: "refresh",
    token_type: "Bearer",
  });
  const automatic = makeNonInteractiveProvider(tenantA, serverId);
  await automatic.tokens();
  expect(automatic.credentialSnapshot("same-token")?.credential_generation).toBe(1);
  expect(automatic.credentialSnapshot("same-token")?.identity?.subject).toBe("first-account");
  await observeSubject(automatic, "same-token", "second-account");
  await saveRefreshResponse(automatic, { access_token: "same-token", token_type: "Bearer" });
  await automatic.tokens();
  expect(automatic.credentialSnapshot("same-token")).toBeNull();
  await automatic.tokens();
  expect(automatic.credentialSnapshot("same-token")).toBeNull();
});

async function saveRefreshResponse(
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
    await provider.saveTokens(tokens);
  });
}

test("refresh without consumed response evidence and conflicting token generations never use the current row as fallback", async () => {
  const serverId = await seedOAuth2Server(tenantA, "response-generation-binding");
  const interactive = makeInteractiveProvider(tenantA, serverId, "response-generation-state");
  await interactive.saveTokens({
    access_token: "initial-response-token",
    refresh_token: "initial-refresh",
    token_type: "Bearer",
  });
  const automatic = makeNonInteractiveProvider(tenantA, serverId);
  await expect(
    automatic.saveTokens({ access_token: "unobserved-token", token_type: "Bearer" }),
  ).rejects.toMatchObject({ code: "credential_generation_changed" });
  await saveRefreshResponse(automatic, {
    access_token: "repeated-response-token",
    token_type: "Bearer",
  });
  await interactive.saveTokens({
    access_token: "new-interactive-token",
    refresh_token: "new-interactive-refresh",
    token_type: "Bearer",
  });
  await expect(
    saveRefreshResponse(automatic, {
      access_token: "repeated-response-token",
      token_type: "Bearer",
    }),
  ).rejects.toMatchObject({ code: "credential_generation_changed" });
  expect((await automatic.tokens())?.access_token).toBe("new-interactive-token");
  await expect(
    saveRefreshResponse(automatic, {
      access_token: "repeated-response-token",
      token_type: "Bearer",
    }),
  ).rejects.toMatchObject({ code: "credential_generation_changed" });
});
