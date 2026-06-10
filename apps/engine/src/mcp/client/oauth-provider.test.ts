// Integration tests for McpDbOAuthClientProvider + makeMcpOAuthProvider.
//
// Uses a real Postgres test DB (createTestDb) because the provider reads
// and writes to:
//   - `credentials`       (oauth2 + oauth2_client slots)
//   - `mcp_oauth_states`  (code_verifier + authorization_url)
//   - `mcp_servers`       (auth_config.client_id mirror)
//
// No SDK auth() network round-trip occurs here — we call the provider
// methods directly. Secret-at-rest assertions read the raw `credentials`
// row (still encrypted) and verify ciphertext != plaintext.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { credentials, mcpOauthStates, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { McpDbOAuthClientProvider, makeMcpOAuthProvider } from "./oauth-provider.ts";
import { createMcpServer } from "./registry.ts";

let ctx: TestDb;
let tenantA: string;
let tenantB: string;

const FAKE_REDIRECT_URI = "https://engine.acmeauth.test/v1/mcp-servers/oauth/callback";
const FAKE_SERVER_URL = "https://examplemcp.acmeauth.test/mcp";
const FAKE_ISSUER = "https://auth.acmeauth.test";

// Deterministic, wall-clock-free expiry seams. The state-row "still valid"
// lookup is `expires_at > now()` against the REAL db `now()`, so we use a
// fixed far-future absolute instant (stable across runs, always ahead of
// real now). The backdated "already expired" instant is a fixed point in
// 2023 — firmly before real now — so the provider's expiry branch fires.
const STATE_FAR_FUTURE = new Date("2999-01-01T00:00:00.000Z");
const TOKEN_EXPIRED_AT = new Date(FROZEN_NOW - 120_000);

function auditCtx() {
  return {
    actor_id: "00000000-0000-0000-0000-000000000001",
    request_source: "api" as const,
    executor: ctx.db,
  };
}

/** Seed an oauth2 MCP server for tenant, return its id. */
async function seedOAuth2Server(tenantId: string, namespace: string): Promise<string> {
  const row = await createMcpServer(
    ctx.db,
    {
      tenant_id: tenantId,
      name: `AcmeAuth ${namespace}`,
      namespace,
      transport: "http",
      url: FAKE_SERVER_URL,
      auth_config: { kind: "oauth2", issuer: FAKE_ISSUER, scope: "read write" },
    },
    auditCtx(),
  );
  return row.id;
}

/** Seed a fresh mcp_oauth_states row to simulate the authorize route's INSERT. */
async function seedStateRow(tenantId: string, serverId: string, state: string): Promise<void> {
  await ctx.db.insert(mcpOauthStates).values({
    tenant_id: tenantId,
    mcp_server_id: serverId,
    state,
    code_verifier: "",
    redirect_uri: FAKE_REDIRECT_URI,
    expires_at: STATE_FAR_FUTURE,
  });
}

/** Build an interactive provider bound to the given state row. */
function makeInteractiveProvider(tenantId: string, serverId: string, state: string) {
  return makeMcpOAuthProvider({
    db: ctx.db,
    tenant_id: tenantId,
    mcp_server_id: serverId,
    environment: "prod",
    redirect_uri: FAKE_REDIRECT_URI,
    state,
    auth: { kind: "oauth2", issuer: FAKE_ISSUER, scope: "read write" },
    interactive: true,
  });
}

/** Build a non-interactive provider (pool handshake mode). */
function makeNonInteractiveProvider(tenantId: string, serverId: string) {
  return makeMcpOAuthProvider({
    db: ctx.db,
    tenant_id: tenantId,
    mcp_server_id: serverId,
    environment: "prod",
    redirect_uri: FAKE_REDIRECT_URI,
    state: "",
    auth: { kind: "oauth2", issuer: FAKE_ISSUER },
    interactive: false,
  });
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

// ── clientMetadata shape ──────────────────────────────────────────────────────

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
      mcp_server_id: serverId,
      environment: "prod",
      redirect_uri: FAKE_REDIRECT_URI,
      state: "state-meta2",
      auth: { kind: "oauth2", issuer: FAKE_ISSUER, scope: "read" },
      interactive: true,
    });
    expect(provider.clientMetadata.scope).toBe("read");
  });

  test("omits scope when auth_config has no scope", async () => {
    const serverId = await seedOAuth2Server(tenantA, "cmeta3");
    const provider = makeMcpOAuthProvider({
      db: ctx.db,
      tenant_id: tenantA,
      mcp_server_id: serverId,
      environment: "prod",
      redirect_uri: FAKE_REDIRECT_URI,
      state: "state-meta3",
      auth: { kind: "oauth2", issuer: FAKE_ISSUER },
      interactive: true,
    });
    expect(provider.clientMetadata.scope).toBeUndefined();
  });
});

// ── saveClientInformation / clientInformation round-trip ─────────────────────

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

    // Read the raw row from DB and check ciphertext is not just the plaintext UTF-8.
    const rows = await ctx.db
      .select({ ciphertext: credentials.ciphertext })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, tenantA),
          eq(credentials.mcp_server_id, serverId),
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
    // The ciphertext must NOT be equal to the plaintext in any form.
    expect(Buffer.compare(Buffer.from(storedBytes), plaintextBytes)).not.toBe(0);
    // And must not CONTAIN the secret string as a substring.
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
    // Create a server with a pre-provisioned client_id on auth_config (no credential row).
    const serverId = await seedOAuth2Server(tenantA, "saveclient4");
    const provider = makeMcpOAuthProvider({
      db: ctx.db,
      tenant_id: tenantA,
      mcp_server_id: serverId,
      environment: "prod",
      redirect_uri: FAKE_REDIRECT_URI,
      state: "state-scl4",
      auth: { kind: "oauth2", issuer: FAKE_ISSUER, client_id: "preprov-client-id" },
      interactive: true,
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

// ── saveTokens / tokens round-trip ───────────────────────────────────────────

describe("McpDbOAuthClientProvider.saveTokens / tokens", () => {
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
    // expires_in should be around 3600 (minus some clock drift; assert > 3500).
    expect(t!.expires_in).toBeGreaterThan(3500);
  });

  test("expires_in derived from oauth2_expires_at — a past expiry yields 0", async () => {
    const serverId = await seedOAuth2Server(tenantA, "tokens3");
    const provider = makeInteractiveProvider(tenantA, serverId, "state-tok3");

    // Save WITH a refresh_token so the row has the refresh triple — only then
    // does getCredentialForMcpServer populate value.expires_at (the field
    // tokens() reads to derive expires_in). Save with a future expiry first.
    await provider.saveTokens({
      access_token: "acme-access-tok-past",
      token_type: "Bearer",
      refresh_token: "acme-refresh-for-expiry-test",
      expires_in: 3600,
    });

    // Overwrite oauth2_expires_at to a past timestamp directly on the row.
    const rows = await ctx.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, tenantA),
          eq(credentials.mcp_server_id, serverId),
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

    // Save a token WITHOUT a refresh_token, with a future expiry first.
    await provider.saveTokens({
      access_token: "acme-access-no-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    });

    // Backdate oauth2_expires_at into the past.
    const rows = await ctx.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, tenantA),
          eq(credentials.mcp_server_id, serverId),
          eq(credentials.mode, "oauth2"),
        ),
      )
      .limit(1);
    await ctx.db
      .update(credentials)
      .set({ oauth2_expires_at: TOKEN_EXPIRED_AT })
      .where(eq(credentials.id, rows[0]!.id));

    // With no refresh_token and a past expiry, tokens() must return undefined
    // (the "authorization required" path) rather than expires_in:0 (which
    // would drive an impossible refresh).
    const t = await provider.tokens();
    expect(t).toBeUndefined();
  });

  test("saveTokens without refresh_token carries forward prior refresh_token", async () => {
    const serverId = await seedOAuth2Server(tenantA, "tokens4");
    const provider = makeInteractiveProvider(tenantA, serverId, "state-tok4");

    // First save with a refresh_token.
    await provider.saveTokens({
      access_token: "acme-access-v1",
      token_type: "Bearer",
      refresh_token: "acme-refresh-v1-keeper",
      expires_in: 3600,
    });

    // Second save without a refresh_token (non-rotating IdP).
    await provider.saveTokens({
      access_token: "acme-access-v2",
      token_type: "Bearer",
      // No refresh_token.
      expires_in: 7200,
    });

    const t = await provider.tokens();
    expect(t!.access_token).toBe("acme-access-v2");
    // The prior refresh_token must be carried forward.
    expect(t!.refresh_token).toBe("acme-refresh-v1-keeper");
  });
});

// ── saveCodeVerifier / codeVerifier round-trip ───────────────────────────────

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

    // Should not throw, and should not write anything.
    await expect(provider.saveCodeVerifier("some-verifier")).resolves.toBeUndefined();

    // No mcp_oauth_states row was written by the non-interactive provider.
    const rows = await ctx.db
      .select()
      .from(mcpOauthStates)
      .where(
        and(eq(mcpOauthStates.tenant_id, tenantA), eq(mcpOauthStates.mcp_server_id, serverId)),
      );
    expect(rows.length).toBe(0);
  });

  test("non-interactive: codeVerifier() throws (no state row)", async () => {
    const serverId = await seedOAuth2Server(tenantA, "verifier3");
    const provider = makeNonInteractiveProvider(tenantA, serverId);

    await expect(provider.codeVerifier()).rejects.toThrow();
  });

  test("interactive: codeVerifier() throws when no matching state row exists", async () => {
    const serverId = await seedOAuth2Server(tenantA, "verifier4");
    // Provider with an interactive flag but NO corresponding state row.
    const provider = makeInteractiveProvider(tenantA, serverId, "no-such-state");

    await expect(provider.codeVerifier()).rejects.toThrow();
  });
});

// ── redirectToAuthorization ───────────────────────────────────────────────────

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
    // The authorization-server ORIGIN must be persisted for the RFC 9207
    // iss check at callback (origin only — no path/query).
    expect(rows[0]!.as_issuer).toBe("https://auth.acmeauth.test");
  });

  test("non-interactive: redirectToAuthorization is a NO-OP — authorization_url stays null", async () => {
    const serverId = await seedOAuth2Server(tenantA, "redirect2");
    const state = "state-redirect2";
    // Seed a state row (as if the interactive authorize route had created one)
    // then give the same state to a non-interactive provider to prove it can't
    // write the URL even if the row exists.
    await seedStateRow(tenantA, serverId, state);

    const provider = makeNonInteractiveProvider(tenantA, serverId);
    const authUrl = new URL("https://auth.acmeauth.test/authorize?client_id=abc");
    await provider.redirectToAuthorization(authUrl);

    const rows = await ctx.db
      .select({ authorization_url: mcpOauthStates.authorization_url })
      .from(mcpOauthStates)
      .where(and(eq(mcpOauthStates.tenant_id, tenantA), eq(mcpOauthStates.state, state)))
      .limit(1);
    // The row must still have a null authorization_url — the non-interactive
    // provider must NEVER write to it.
    expect(rows[0]!.authorization_url).toBeNull();
  });
});

// ── invalidateCredentials ─────────────────────────────────────────────────────

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
          eq(credentials.mcp_server_id, serverId),
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
          eq(credentials.mcp_server_id, serverId),
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

    // Confirm row exists.
    const beforeRows = await ctx.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, tenantA),
          eq(credentials.mcp_server_id, serverId),
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
          eq(credentials.mcp_server_id, serverId),
          eq(credentials.mode, "oauth2_client"),
        ),
      );
    expect(afterRows.length).toBe(0);

    // The auth_config.client_id should be gone (mirrored client_id cleared).
    const { mcpServers } = await import("../../db/schema/index.ts");
    const serverRows = await ctx.db
      .select({ auth_config: mcpServers.auth_config })
      .from(mcpServers)
      .where(and(eq(mcpServers.tenant_id, tenantA), eq(mcpServers.id, serverId)))
      .limit(1);
    const authConfig = serverRows[0]!.auth_config as Record<string, unknown>;
    expect(authConfig.client_id).toBeUndefined();
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

// ── Tenant isolation ──────────────────────────────────────────────────────────

describe("McpDbOAuthClientProvider tenant isolation", () => {
  test("tenant A's provider cannot read tenant B's tokens", async () => {
    // Seed a server for B and save tokens using B's provider.
    const serverIdB = await seedOAuth2Server(tenantB, "isolate1");
    const providerB = makeMcpOAuthProvider({
      db: ctx.db,
      tenant_id: tenantB,
      mcp_server_id: serverIdB,
      environment: "prod",
      redirect_uri: FAKE_REDIRECT_URI,
      state: "state-iso-b",
      auth: { kind: "oauth2", issuer: FAKE_ISSUER },
      interactive: true,
    });
    await providerB.saveTokens({ access_token: "b-only-token", token_type: "Bearer" });

    // Seed a server for A with the SAME namespace (scoped by tenant).
    const serverIdA = await seedOAuth2Server(tenantA, "isolate1");
    const providerA = makeMcpOAuthProvider({
      db: ctx.db,
      tenant_id: tenantA,
      mcp_server_id: serverIdA,
      environment: "prod",
      redirect_uri: FAKE_REDIRECT_URI,
      state: "state-iso-a",
      auth: { kind: "oauth2", issuer: FAKE_ISSUER },
      interactive: true,
    });

    // A has no tokens — should NOT see B's token.
    const aTokens = await providerA.tokens();
    expect(aTokens).toBeUndefined();
  });

  test("tenant A's provider cannot read tenant B's client credentials", async () => {
    const serverIdB = await seedOAuth2Server(tenantB, "isolateclient1");
    const providerB = makeMcpOAuthProvider({
      db: ctx.db,
      tenant_id: tenantB,
      mcp_server_id: serverIdB,
      environment: "prod",
      redirect_uri: FAKE_REDIRECT_URI,
      state: "state-iso-client-b",
      auth: { kind: "oauth2", issuer: FAKE_ISSUER },
      interactive: true,
    });
    await providerB.saveClientInformation({ client_id: "b-client-id" });

    const serverIdA = await seedOAuth2Server(tenantA, "isolateclient1");
    const providerA = makeMcpOAuthProvider({
      db: ctx.db,
      tenant_id: tenantA,
      mcp_server_id: serverIdA,
      environment: "prod",
      redirect_uri: FAKE_REDIRECT_URI,
      state: "state-iso-client-a",
      auth: { kind: "oauth2", issuer: FAKE_ISSUER },
      interactive: true,
    });

    // A has no client credential row; without a pre-provisioned client_id on
    // auth_config either, it returns undefined (not B's "b-client-id").
    const aInfo = await providerA.clientInformation();
    expect(aInfo).toBeUndefined();
  });
});
