// Integration tests for MCP OAuth server-provider state machine.
// Uses a real disposable Postgres DB — no mocks.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Config } from "../../config/schema.ts";
import type { Db } from "../../db/client.ts";
import {
  mcpOauthAccessTokens,
  mcpOauthRefreshTokens,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createMcpOAuthProvider, type McpOAuthProvider } from "./server-provider.ts";
import { sha256Hex } from "./tokens.ts";

// Minimal config that satisfies createMcpOAuthProvider without loadConfig().
function makeConfig(): Config {
  return {
    server: {
      public_base_url: "https://test.example.com",
      port: 3000,
      host: "0.0.0.0",
    },
    auth: {
      mcp_oauth: {
        enabled: true,
        dynamic_registration_enabled: true,
        access_token_ttl_seconds: 3600,
        refresh_token_ttl_seconds: 2592000,
        authorization_code_ttl_seconds: 60,
        scopes_supported: ["mcp:read", "mcp:authoring", "mcp:admin"],
      },
    },
  } as unknown as Config;
}

let testDb: TestDb;
let db: Db;
let tenantId: string;
let userId: string;
let provider: McpOAuthProvider;

const REDIRECT_URI = "https://client.example.com/callback";
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

function makeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

const CODE_CHALLENGE = makeChallenge(CODE_VERIFIER);

beforeAll(async () => {
  testDb = await createTestDb("mcp-oauth-provider");
  db = testDb.db;
  const config = makeConfig();

  const [t] = await db
    .insert(tenants)
    .values({ slug: "mcp-oauth-prov", display_name: "MCP OAuth Provider Test" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenantId = t.id;

  const [u] = await db
    .insert(users)
    .values({ tenant_id: tenantId, email: "mcp-oauth@test.local", role: "admin" })
    .returning();
  if (!u) throw new Error("seed user failed");
  userId = u.id;

  provider = createMcpOAuthProvider({ db, config });
}, 30_000);

afterAll(async () => {
  await testDb.cleanup();
}, 30_000);

// Helper: register a client and return its client_id.
async function registerTestClient(opts?: {
  redirect_uris?: string[];
  scope?: string;
}): Promise<string> {
  const result = await provider.registerClient({
    redirect_uris: opts?.redirect_uris ?? [REDIRECT_URI],
    client_name: "Test Client",
    scope: opts?.scope ?? "mcp:read",
  });
  return result.client_id;
}

// Helper: run the full authorize → exchange flow.
async function issueTokenPair(opts?: {
  clientId?: string;
  scope?: string;
  verifier?: string;
  challenge?: string;
}): Promise<{
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  expires_in: number;
  scope: string;
}> {
  const clientId =
    opts?.clientId ??
    (await registerTestClient(opts?.scope !== undefined ? { scope: opts.scope } : undefined));
  const verifier = opts?.verifier ?? CODE_VERIFIER;
  const challenge = opts?.challenge ?? CODE_CHALLENGE;

  const code = await provider.issueAuthorizationCode({
    clientId,
    tenantId,
    userId,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    scope: opts?.scope ?? "mcp:read",
  });

  return provider.exchangeAuthorizationCode({
    code,
    codeVerifier: verifier,
    redirectUri: REDIRECT_URI,
    clientId,
  });
}

// ─── registerClient ────────────────────────────────────────────────────────

describe("registerClient", () => {
  test("inserts a row and returns client_id, redirect_uris, grant_types", async () => {
    const result = await provider.registerClient({
      redirect_uris: [REDIRECT_URI],
      client_name: "My MCP App",
    });
    expect(typeof result.client_id).toBe("string");
    expect(result.client_id.length).toBeGreaterThan(0);
    expect(result.redirect_uris).toEqual([REDIRECT_URI]);
    expect(result.grant_types).toContain("authorization_code");
    expect(result.grant_types).toContain("refresh_token");
  });

  test("default scope is mcp:read when not provided", async () => {
    const result = await provider.registerClient({ redirect_uris: [REDIRECT_URI] });
    expect(result.scope).toBe("mcp:read");
  });

  test("registerClient completes without error (audit is fire-and-forget to global db)", async () => {
    // audit() in server-provider uses the global db connection, not the test db.
    // Audit log assertions are validated at the HTTP layer (mcp-oauth-routes.test.ts)
    // where the full stack is wired. Here we confirm registration succeeds and the
    // client row is queryable.
    const result = await provider.registerClient({
      redirect_uris: [REDIRECT_URI],
      client_name: "AuditTest",
    });
    expect(result.client_id).toBeDefined();
    const client = await provider.getClient(result.client_id);
    expect(client).not.toBeNull();
  });

  test("getClient returns the registered client", async () => {
    const result = await provider.registerClient({
      redirect_uris: [REDIRECT_URI],
      client_name: "GetClientTest",
    });
    const client = await provider.getClient(result.client_id);
    expect(client).not.toBeNull();
    expect(client?.client_id).toBe(result.client_id);
    expect(client?.redirect_uris).toEqual([REDIRECT_URI]);
  });

  test("getClient returns null for unknown client_id", async () => {
    const result = await provider.getClient("00000000000000000000000000000000");
    expect(result).toBeNull();
  });

  test("token_endpoint_auth_method=client_secret_basic throws invalid_client_metadata", async () => {
    let err: unknown;
    try {
      await provider.registerClient({
        redirect_uris: [REDIRECT_URI],
        client_name: "ConfidentialBasic",
        token_endpoint_auth_method: "client_secret_basic",
      });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeUndefined();
    expect((err as { oauth_error?: string }).oauth_error).toBe("invalid_client_metadata");
  });

  test("token_endpoint_auth_method=client_secret_post throws invalid_client_metadata", async () => {
    let err: unknown;
    try {
      await provider.registerClient({
        redirect_uris: [REDIRECT_URI],
        client_name: "ConfidentialPost",
        token_endpoint_auth_method: "client_secret_post",
      });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeUndefined();
    expect((err as { oauth_error?: string }).oauth_error).toBe("invalid_client_metadata");
  });
});

// ─── issueAuthorizationCode + exchangeAuthorizationCode ───────────────────

describe("authorization code flow", () => {
  test("happy path returns access_token + refresh_token", async () => {
    const tokens = await issueTokenPair();
    expect(tokens.access_token).toMatch(/^wf_mcp_/);
    expect(tokens.refresh_token).toMatch(/^wf_mcr_/);
    expect(tokens.token_type).toBe("bearer");
    expect(typeof tokens.expires_in).toBe("number");
    expect(tokens.scope).toBe("mcp:read");
  });

  test("exchange returns token_type=bearer and expires_in (audit fire-and-forget)", async () => {
    // audit() uses global db — see registerClient test note.
    // Verify the exchange response shape which confirms the happy path ran.
    const tokens = await issueTokenPair();
    expect(tokens.token_type).toBe("bearer");
    expect(tokens.expires_in).toBeGreaterThan(0);
  });

  test("code is single-use: second exchange throws invalid_grant", async () => {
    const clientId = await registerTestClient();
    const code = await provider.issueAuthorizationCode({
      clientId,
      tenantId,
      userId,
      redirectUri: REDIRECT_URI,
      codeChallenge: CODE_CHALLENGE,
      scope: "mcp:read",
    });

    await provider.exchangeAuthorizationCode({
      code,
      codeVerifier: CODE_VERIFIER,
      redirectUri: REDIRECT_URI,
      clientId,
    });

    // Second exchange must fail
    let err: unknown;
    try {
      await provider.exchangeAuthorizationCode({
        code,
        codeVerifier: CODE_VERIFIER,
        redirectUri: REDIRECT_URI,
        clientId,
      });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeUndefined();
    expect((err as { oauth_error?: string }).oauth_error).toBe("invalid_grant");
  });

  test("expired code is rejected", async () => {
    const clientId = await registerTestClient();
    const code = await provider.issueAuthorizationCode({
      clientId,
      tenantId,
      userId,
      redirectUri: REDIRECT_URI,
      codeChallenge: CODE_CHALLENGE,
      scope: "mcp:read",
    });

    // Backdate the code's expires_at so it is already expired.
    const codeHash = sha256Hex(code);
    const { mcpOauthAuthorizationCodes } = await import("../../db/schema/index.ts");
    await db
      .update(mcpOauthAuthorizationCodes)
      .set({ expires_at: new Date(Date.now() - 10_000) }) // allow-wall-clock
      .where(eq(mcpOauthAuthorizationCodes.code_sha256, codeHash));

    let err: unknown;
    try {
      await provider.exchangeAuthorizationCode({
        code,
        codeVerifier: CODE_VERIFIER,
        redirectUri: REDIRECT_URI,
        clientId,
      });
    } catch (e) {
      err = e;
    }
    expect((err as { oauth_error?: string }).oauth_error).toBe("invalid_grant");
  });

  test("wrong code_verifier rejected (PKCE failure)", async () => {
    const clientId = await registerTestClient();
    const code = await provider.issueAuthorizationCode({
      clientId,
      tenantId,
      userId,
      redirectUri: REDIRECT_URI,
      codeChallenge: CODE_CHALLENGE,
      scope: "mcp:read",
    });

    let err: unknown;
    try {
      await provider.exchangeAuthorizationCode({
        code,
        codeVerifier: "wrong-verifier-value-that-does-not-match",
        redirectUri: REDIRECT_URI,
        clientId,
      });
    } catch (e) {
      err = e;
    }
    expect((err as { oauth_error?: string }).oauth_error).toBe("invalid_grant");
  });

  test("redirect_uri mismatch rejected (open-redirect guard)", async () => {
    const clientId = await registerTestClient();
    const code = await provider.issueAuthorizationCode({
      clientId,
      tenantId,
      userId,
      redirectUri: REDIRECT_URI,
      codeChallenge: CODE_CHALLENGE,
      scope: "mcp:read",
    });

    let err: unknown;
    try {
      await provider.exchangeAuthorizationCode({
        code,
        codeVerifier: CODE_VERIFIER,
        redirectUri: "https://attacker.example.com/steal",
        clientId,
      });
    } catch (e) {
      err = e;
    }
    expect((err as { oauth_error?: string }).oauth_error).toBe("invalid_grant");
  });

  test("unknown code throws invalid_grant", async () => {
    let err: unknown;
    try {
      await provider.exchangeAuthorizationCode({
        code: "nonexistent-code-value-abcdef123456",
        codeVerifier: CODE_VERIFIER,
        redirectUri: REDIRECT_URI,
        clientId: "someclientid",
      });
    } catch (e) {
      err = e;
    }
    expect((err as { oauth_error?: string }).oauth_error).toBe("invalid_grant");
  });
});

// ─── exchangeRefreshToken ──────────────────────────────────────────────────

describe("refresh token rotation", () => {
  test("rotation returns new access_token + refresh_token", async () => {
    const first = await issueTokenPair({ scope: "mcp:read" });
    const clientId = await registerTestClient({ scope: "mcp:read mcp:authoring" });

    // Use the specific clientId that issued first
    const firstPair = await issueTokenPair({ clientId, scope: "mcp:read" });

    const refreshed = await provider.exchangeRefreshToken({
      refreshToken: firstPair.refresh_token,
      clientId,
    });
    expect(refreshed.access_token).toMatch(/^wf_mcp_/);
    expect(refreshed.refresh_token).toMatch(/^wf_mcr_/);
    expect(refreshed.access_token).not.toBe(firstPair.access_token);
    expect(refreshed.refresh_token).not.toBe(firstPair.refresh_token);
    void first;
  });

  test("old refresh token has rotated_to_id set after rotation", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const firstPair = await issueTokenPair({ clientId, scope: "mcp:read" });

    await provider.exchangeRefreshToken({
      refreshToken: firstPair.refresh_token,
      clientId,
    });

    const oldHash = sha256Hex(firstPair.refresh_token);
    const rows = await db
      .select({ rotated_to_id: mcpOauthRefreshTokens.rotated_to_id })
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.token_sha256, oldHash))
      .limit(1);
    expect(rows[0]?.rotated_to_id).not.toBeNull();
  });

  test("rotation response has valid token shapes (audit fire-and-forget)", async () => {
    // audit() uses global db — see registerClient test note.
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const firstPair = await issueTokenPair({ clientId, scope: "mcp:read" });

    const refreshed = await provider.exchangeRefreshToken({
      refreshToken: firstPair.refresh_token,
      clientId,
    });

    expect(refreshed.token_type).toBe("bearer");
    expect(refreshed.expires_in).toBeGreaterThan(0);
  });

  test("replaying a rotated refresh token revokes the chain (invalid_grant)", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const firstPair = await issueTokenPair({ clientId, scope: "mcp:read" });

    // First rotation — valid
    await provider.exchangeRefreshToken({
      refreshToken: firstPair.refresh_token,
      clientId,
    });

    // Replay the already-rotated token — must revoke chain
    let err: unknown;
    try {
      await provider.exchangeRefreshToken({
        refreshToken: firstPair.refresh_token,
        clientId,
      });
    } catch (e) {
      err = e;
    }
    expect((err as { oauth_error?: string }).oauth_error).toBe("invalid_grant");

    // Old refresh token row must now be revoked
    const oldHash = sha256Hex(firstPair.refresh_token);
    const rows = await db
      .select({ revoked_at: mcpOauthRefreshTokens.revoked_at })
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.token_sha256, oldHash))
      .limit(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
  });

  test("revoked refresh token rejected immediately", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const firstPair = await issueTokenPair({ clientId, scope: "mcp:read" });

    // Manually revoke the token
    const refreshHash = sha256Hex(firstPair.refresh_token);
    await db
      .update(mcpOauthRefreshTokens)
      .set({ revoked_at: new Date(Date.now() - 1000) }) // allow-wall-clock
      .where(eq(mcpOauthRefreshTokens.token_sha256, refreshHash));

    let err: unknown;
    try {
      await provider.exchangeRefreshToken({
        refreshToken: firstPair.refresh_token,
        clientId,
      });
    } catch (e) {
      err = e;
    }
    expect((err as { oauth_error?: string }).oauth_error).toBe("invalid_grant");
  });

  test("expired refresh token rejected", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const firstPair = await issueTokenPair({ clientId, scope: "mcp:read" });

    // Backdate expires_at
    const refreshHash = sha256Hex(firstPair.refresh_token);
    await db
      .update(mcpOauthRefreshTokens)
      .set({ expires_at: new Date(Date.now() - 10_000) }) // allow-wall-clock
      .where(eq(mcpOauthRefreshTokens.token_sha256, refreshHash));

    let err: unknown;
    try {
      await provider.exchangeRefreshToken({
        refreshToken: firstPair.refresh_token,
        clientId,
      });
    } catch (e) {
      err = e;
    }
    expect((err as { oauth_error?: string }).oauth_error).toBe("invalid_grant");
  });

  test("scope downgrade: narrower scope honored on refresh", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read mcp:authoring" });
    const firstPair = await issueTokenPair({ clientId, scope: "mcp:read mcp:authoring" });

    const refreshed = await provider.exchangeRefreshToken({
      refreshToken: firstPair.refresh_token,
      clientId,
      scope: "mcp:read",
    });
    expect(refreshed.scope).toBe("mcp:read");
  });

  test("scope expansion: cannot add scopes not in original grant", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const firstPair = await issueTokenPair({ clientId, scope: "mcp:read" });

    const refreshed = await provider.exchangeRefreshToken({
      refreshToken: firstPair.refresh_token,
      clientId,
      scope: "mcp:read mcp:admin",
    });
    // mcp:admin was NOT in the original grant — must be stripped
    const scopes = refreshed.scope.split(" ");
    expect(scopes).not.toContain("mcp:admin");
    expect(scopes).toContain("mcp:read");
  });
});

// ─── verifyAccessToken ─────────────────────────────────────────────────────
// verifyAccessToken was removed — it constant-time-compared a value to
// itself. The real verification path is the auth provider (mcp-oauth.ts).
// These tests are skipped; the underlying DB queries they exercised are
// covered by the auth provider tests.

// ─── revokeToken ───────────────────────────────────────────────────────────

describe("revokeToken", () => {
  test("revoking an access token sets revoked_at (audit fire-and-forget)", async () => {
    // audit() uses global db — see registerClient test note.
    // We verify the DB-visible side effect: revoked_at is set.
    const pair = await issueTokenPair();
    await provider.revokeToken(pair.access_token);

    const tokenHash = sha256Hex(pair.access_token);
    const rows = await db
      .select({ revoked_at: mcpOauthAccessTokens.revoked_at })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.token_sha256, tokenHash))
      .limit(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
  });

  test("revoking a refresh token sets revoked_at", async () => {
    const pair = await issueTokenPair();
    await provider.revokeToken(pair.refresh_token);

    const tokenHash = sha256Hex(pair.refresh_token);
    const rows = await db
      .select({ revoked_at: mcpOauthRefreshTokens.revoked_at })
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.token_sha256, tokenHash))
      .limit(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
  });

  test("revoking an unknown token silently succeeds (RFC 7009)", async () => {
    await expect(
      provider.revokeToken("wf_mcp_totallyunknowntoken1234567890"),
    ).resolves.toBeUndefined();
  });
});
