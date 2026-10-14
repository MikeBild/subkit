import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Config } from "../../config/schema.ts";
import type { Db } from "../../db/client.ts";
import {
  auditLog,
  mcpOauthAccessTokens,
  mcpOauthGrants,
  mcpOauthRefreshTokens,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../db/tests/setup.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { revokeOAuthRefreshTokenFamily } from "./refresh-token-revocation.ts";
import { createMcpOAuthProvider, type McpOAuthProvider } from "./server-provider.ts";
import { sha256Hex } from "./tokens.ts";

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
    .values({
      tenant_id: tenantId,
      email: "mcp-oauth@test.local",
      role_id: await builtinRoleId(db, "admin"),
    })
    .returning();
  if (!u) throw new Error("seed user failed");
  userId = u.id;

  provider = createMcpOAuthProvider({ db, config });
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  if (testDb) await testDb.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

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

async function issueTokenPair(opts?: {
  clientId?: string;
  scope?: string;
  verifier?: string;
  challenge?: string;
  resource?: string;
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
    ...(opts?.resource ? { resource: opts.resource } : {}),
  });

  return provider.exchangeAuthorizationCode({
    code,
    codeVerifier: verifier,
    redirectUri: REDIRECT_URI,
    clientId,
  });
}

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

  test("default scope is the full supported set when not provided", async () => {
    const result = await provider.registerClient({ redirect_uris: [REDIRECT_URI] });
    const scopes = result.scope.split(" ");
    expect(scopes).toContain("mcp:read");
    expect(scopes).toContain("mcp:authoring");
    expect(scopes).toContain("mcp:admin");
  });

  test("registerClient writes a mcp_oauth.client_registered audit row", async () => {
    const result = await provider.registerClient({
      redirect_uris: [REDIRECT_URI],
      client_name: "AuditTest",
    });
    expect(result.client_id).toBeDefined();
    const client = await provider.getClient(result.client_id);
    expect(client).not.toBeNull();

    const rows = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, "00000000-0000-0000-0000-000000000000"),
          eq(auditLog.action, "mcp_oauth.client_registered"),
        ),
      )
      .limit(10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
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

describe("authorization code flow", () => {
  test("records one user and client grant for the access and refresh token family", async () => {
    const clientId = await registerTestClient();
    const tokens = await issueTokenPair({ clientId });
    const accessHash = sha256Hex(tokens.access_token);
    const refreshHash = sha256Hex(tokens.refresh_token);
    const [access] = await db
      .select({ grant_id: mcpOauthAccessTokens.grant_id })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.token_sha256, accessHash));
    const [refresh] = await db
      .select({ grant_id: mcpOauthRefreshTokens.grant_id })
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.token_sha256, refreshHash));
    expect(access?.grant_id).toBeDefined();
    expect(refresh?.grant_id).toBe(access?.grant_id);

    const [grant] = await db
      .select({
        tenant_id: mcpOauthGrants.tenant_id,
        client_id: mcpOauthGrants.client_id,
        user_id: mcpOauthGrants.user_id,
      })
      .from(mcpOauthGrants)
      .where(eq(mcpOauthGrants.id, access!.grant_id!));
    expect(grant).toEqual({ tenant_id: tenantId, client_id: clientId, user_id: userId });
  });

  test("happy path returns access_token + refresh_token", async () => {
    const tokens = await issueTokenPair();
    expect(tokens.access_token).toMatch(/^wf_mcp_/);
    expect(tokens.refresh_token).toMatch(/^wf_mcr_/);
    expect(tokens.token_type).toBe("bearer");
    expect(typeof tokens.expires_in).toBe("number");
    expect(tokens.scope).toBe("mcp:read");
  });

  test("exchangeAuthorizationCode writes a mcp_oauth.token_issued audit row", async () => {
    const tokens = await issueTokenPair();
    expect(tokens.token_type).toBe("bearer");
    expect(tokens.expires_in).toBeGreaterThan(0);

    const rows = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, "mcp_oauth.token_issued")))
      .limit(10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
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

describe("refresh token rotation", () => {
  test("rotation returns new access_token + refresh_token", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read mcp:authoring" });
    const firstPair = await issueTokenPair({ clientId, scope: "mcp:read" });
    const [original] = await db
      .select({ grant_id: mcpOauthRefreshTokens.grant_id })
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.token_sha256, sha256Hex(firstPair.refresh_token)));

    const refreshed = await provider.exchangeRefreshToken({
      refreshToken: firstPair.refresh_token,
      clientId,
    });
    expect(refreshed.access_token).toMatch(/^wf_mcp_/);
    expect(refreshed.refresh_token).toMatch(/^wf_mcr_/);
    expect(refreshed.access_token).not.toBe(firstPair.access_token);
    expect(refreshed.refresh_token).not.toBe(firstPair.refresh_token);
    const [rotated] = await db
      .select({ grant_id: mcpOauthRefreshTokens.grant_id })
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.token_sha256, sha256Hex(refreshed.refresh_token)));
    expect(rotated?.grant_id).toBe(original?.grant_id);
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

  test("exchangeRefreshToken writes a mcp_oauth.token_refreshed audit row", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const firstPair = await issueTokenPair({ clientId, scope: "mcp:read" });

    const refreshed = await provider.exchangeRefreshToken({
      refreshToken: firstPair.refresh_token,
      clientId,
    });

    expect(refreshed.token_type).toBe("bearer");
    expect(refreshed.expires_in).toBeGreaterThan(0);

    const rows = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, "mcp_oauth.token_refreshed")),
      )
      .limit(10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("a client echoing back the returned scope cannot accumulate duplicates", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read mcp:authoring" });
    let pair = await issueTokenPair({ clientId, scope: "mcp:read mcp:authoring" });
    expect(pair.scope).toBe("mcp:read mcp:authoring");

    for (let i = 0; i < 4; i++) {
      const next = await provider.exchangeRefreshToken({
        refreshToken: pair.refresh_token,
        clientId,
        scope: pair.scope,
      });
      const parts = next.scope.split(" ").filter(Boolean);
      expect(new Set(parts).size).toBe(parts.length);
      expect(parts.sort()).toEqual(["mcp:authoring", "mcp:read"]);
      pair = { ...pair, refresh_token: next.refresh_token, scope: next.scope };
    }
  });

  test("a refresh token with a pre-doubled stored scope self-heals on rotation", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read mcp:authoring" });
    const pair = await issueTokenPair({ clientId, scope: "mcp:read mcp:authoring" });

    const refreshHash = sha256Hex(pair.refresh_token);
    await db
      .update(mcpOauthRefreshTokens)
      .set({ scope: "mcp:read mcp:authoring mcp:read mcp:authoring mcp:read mcp:authoring" })
      .where(eq(mcpOauthRefreshTokens.token_sha256, refreshHash));

    const refreshed = await provider.exchangeRefreshToken({
      refreshToken: pair.refresh_token,
      clientId,
    });
    const parts = refreshed.scope.split(" ").filter(Boolean);
    expect(new Set(parts).size).toBe(parts.length);
    expect(parts.sort()).toEqual(["mcp:authoring", "mcp:read"]);
  });

  test("replaying a rotated refresh token revokes the chain (invalid_grant)", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const firstPair = await issueTokenPair({ clientId, scope: "mcp:read" });

    await provider.exchangeRefreshToken({
      refreshToken: firstPair.refresh_token,
      clientId,
    });

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

    const oldHash = sha256Hex(firstPair.refresh_token);
    const rows = await db
      .select({
        revoked_at: mcpOauthRefreshTokens.revoked_at,
        grant_id: mcpOauthRefreshTokens.grant_id,
      })
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.token_sha256, oldHash))
      .limit(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
    const grants = await db
      .select({ revoked_at: mcpOauthGrants.revoked_at })
      .from(mcpOauthGrants)
      .where(eq(mcpOauthGrants.id, rows[0]!.grant_id!));
    expect(grants[0]?.revoked_at).not.toBeNull();
  });

  test("concurrent replay revokes the family after the losing rotation rolls back", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const firstPair = await issueTokenPair({ clientId, scope: "mcp:read" });
    const oldHash = sha256Hex(firstPair.refresh_token);
    const [original] = await db
      .select({ id: mcpOauthRefreshTokens.id, grant_id: mcpOauthRefreshTokens.grant_id })
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.token_sha256, oldHash));
    if (!original?.grant_id) throw new Error("refresh grant fixture missing");

    const blocker = await testDb.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM subkit.users WHERE id = $1 FOR UPDATE", [userId]);
    const requests = Promise.allSettled([
      provider.exchangeRefreshToken({ refreshToken: firstPair.refresh_token, clientId }),
      provider.exchangeRefreshToken({ refreshToken: firstPair.refresh_token, clientId }),
    ]);

    try {
      await waitFor(
        async () => {
          const result = await testDb.pool.query<{ waiting: number }>(
            "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%for update%'",
          );
          return (result.rows[0]?.waiting ?? 0) >= 2;
        },
        { tries: 2_000, label: "two OAuth rotations waiting on the user lock" },
      );
    } finally {
      await blocker.query("COMMIT");
      blocker.release();
    }

    const outcomes = await requests;
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const failure = rejected[0];
    if (failure?.status !== "rejected") throw new Error("expected a replay rejection");
    expect((failure.reason as { oauth_error?: string }).oauth_error).toBe("invalid_grant");

    const refreshRows = await db
      .select({ revoked_at: mcpOauthRefreshTokens.revoked_at })
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.grant_id, original.grant_id));
    const accessRows = await db
      .select({ revoked_at: mcpOauthAccessTokens.revoked_at })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.grant_id, original.grant_id));
    const [grant] = await db
      .select({ revoked_at: mcpOauthGrants.revoked_at })
      .from(mcpOauthGrants)
      .where(eq(mcpOauthGrants.id, original.grant_id));

    expect(refreshRows).toHaveLength(2);
    expect(refreshRows.every((row) => row.revoked_at !== null)).toBe(true);
    expect(accessRows).toHaveLength(2);
    expect(accessRows.every((row) => row.revoked_at !== null)).toBe(true);
    expect(grant?.revoked_at).not.toBeNull();
  });

  test("revoked refresh token rejected immediately", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const firstPair = await issueTokenPair({ clientId, scope: "mcp:read" });

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
    const scopes = refreshed.scope.split(" ");
    expect(scopes).not.toContain("mcp:admin");
    expect(scopes).toContain("mcp:read");
  });

  test("3-hop chain replay revokes all tokens (A→B→C, replay A revokes A+B+C)", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });

    const pairA = await issueTokenPair({ clientId, scope: "mcp:read" });

    const pairB = await provider.exchangeRefreshToken({
      refreshToken: pairA.refresh_token,
      clientId,
    });

    const pairC = await provider.exchangeRefreshToken({
      refreshToken: pairB.refresh_token,
      clientId,
    });
    void pairC;

    let err: unknown;
    try {
      await provider.exchangeRefreshToken({ refreshToken: pairA.refresh_token, clientId });
    } catch (e) {
      err = e;
    }
    expect((err as { oauth_error?: string }).oauth_error).toBe("invalid_grant");

    for (const pair of [pairA, pairB, pairC]) {
      const h = sha256Hex(pair.refresh_token);
      const rows = await db
        .select({ revoked_at: mcpOauthRefreshTokens.revoked_at })
        .from(mcpOauthRefreshTokens)
        .where(eq(mcpOauthRefreshTokens.token_sha256, h))
        .limit(1);
      expect(rows[0]?.revoked_at).not.toBeNull();
    }

    for (const pair of [pairA, pairB, pairC]) {
      const h = sha256Hex(pair.access_token);
      const rows = await db
        .select({ revoked_at: mcpOauthAccessTokens.revoked_at })
        .from(mcpOauthAccessTokens)
        .where(eq(mcpOauthAccessTokens.token_sha256, h))
        .limit(1);
      expect(rows[0]?.revoked_at).not.toBeNull();
    }
  });

  const AUDIENCE = "https://test.example.com/mcp";

  test("rotated access token carries the audience the code was issued with", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const firstPair = await issueTokenPair({ clientId, scope: "mcp:read", resource: AUDIENCE });

    const [firstAccess] = await db
      .select({ resource: mcpOauthAccessTokens.resource })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.token_sha256, sha256Hex(firstPair.access_token)))
      .limit(1);
    expect(firstAccess?.resource).toBe(AUDIENCE);

    const refreshed = await provider.exchangeRefreshToken({
      refreshToken: firstPair.refresh_token,
      clientId,
    });

    const [rotatedAccess] = await db
      .select({ resource: mcpOauthAccessTokens.resource })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.token_sha256, sha256Hex(refreshed.access_token)))
      .limit(1);
    expect(rotatedAccess?.resource).toBe(AUDIENCE);

    const [rotatedRefresh] = await db
      .select({ resource: mcpOauthRefreshTokens.resource })
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.token_sha256, sha256Hex(refreshed.refresh_token)))
      .limit(1);
    expect(rotatedRefresh?.resource).toBe(AUDIENCE);
  });

  test("audience survives multiple rotations (chain keeps carrying it)", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const pairA = await issueTokenPair({ clientId, scope: "mcp:read", resource: AUDIENCE });

    const pairB = await provider.exchangeRefreshToken({
      refreshToken: pairA.refresh_token,
      clientId,
    });
    const pairC = await provider.exchangeRefreshToken({
      refreshToken: pairB.refresh_token,
      clientId,
    });

    const [thirdHopAccess] = await db
      .select({ resource: mcpOauthAccessTokens.resource })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.token_sha256, sha256Hex(pairC.access_token)))
      .limit(1);
    expect(thirdHopAccess?.resource).toBe(AUDIENCE);
  });

  test("audience-less grant stays audience-less on rotation (no phantom audience)", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const firstPair = await issueTokenPair({ clientId, scope: "mcp:read" });

    const refreshed = await provider.exchangeRefreshToken({
      refreshToken: firstPair.refresh_token,
      clientId,
    });

    const [rotatedAccess] = await db
      .select({ resource: mcpOauthAccessTokens.resource })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.token_sha256, sha256Hex(refreshed.access_token)))
      .limit(1);
    expect(rotatedAccess?.resource).toBeNull();
  });
});

describe("revokeToken", () => {
  test("refresh-family revocation is a no-op for a different tenant", async () => {
    const pair = await issueTokenPair();
    const refreshHash = sha256Hex(pair.refresh_token);
    const accessHash = sha256Hex(pair.access_token);
    const [refreshBefore] = await db
      .select({ id: mcpOauthRefreshTokens.id, grant_id: mcpOauthRefreshTokens.grant_id })
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.token_sha256, refreshHash))
      .limit(1);
    if (!refreshBefore) throw new Error("refresh token fixture missing");

    await db.transaction((tx) =>
      revokeOAuthRefreshTokenFamily(
        tx,
        refreshBefore.id,
        "00000000-0000-4000-8000-000000000000",
        new Date("2026-10-11T00:00:00.000Z"),
      ),
    );

    const [refreshAfter] = await db
      .select({ revoked_at: mcpOauthRefreshTokens.revoked_at })
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.id, refreshBefore.id))
      .limit(1);
    const [accessAfter] = await db
      .select({ revoked_at: mcpOauthAccessTokens.revoked_at })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.token_sha256, accessHash))
      .limit(1);
    expect(refreshAfter?.revoked_at).toBeNull();
    expect(accessAfter?.revoked_at).toBeNull();
    if (refreshBefore.grant_id) {
      const [grantAfter] = await db
        .select({ revoked_at: mcpOauthGrants.revoked_at })
        .from(mcpOauthGrants)
        .where(eq(mcpOauthGrants.id, refreshBefore.grant_id))
        .limit(1);
      expect(grantAfter?.revoked_at).toBeNull();
    }
  });

  test("revoking an access token sets revoked_at and writes mcp_oauth.token_revoked audit row", async () => {
    const pair = await issueTokenPair();
    await provider.revokeToken(pair.access_token);

    const tokenHash = sha256Hex(pair.access_token);
    const rows = await db
      .select({ revoked_at: mcpOauthAccessTokens.revoked_at })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.token_sha256, tokenHash))
      .limit(1);
    expect(rows[0]?.revoked_at).not.toBeNull();

    const auditRows = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, "mcp_oauth.token_revoked")))
      .limit(10);
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
  });

  test("revoking a refresh token revokes its access-token family", async () => {
    const pair = await issueTokenPair();
    await provider.revokeToken(pair.refresh_token);

    const refreshHash = sha256Hex(pair.refresh_token);
    const refreshRows = await db
      .select({ revoked_at: mcpOauthRefreshTokens.revoked_at })
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.token_sha256, refreshHash))
      .limit(1);
    expect(refreshRows[0]?.revoked_at).not.toBeNull();

    const accessHash = sha256Hex(pair.access_token);
    const accessRows = await db
      .select({ revoked_at: mcpOauthAccessTokens.revoked_at })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.token_sha256, accessHash))
      .limit(1);
    expect(accessRows[0]?.revoked_at).not.toBeNull();
  });

  test("revoking an unknown token silently succeeds (RFC 7009)", async () => {
    await expect(
      provider.revokeToken("wf_mcp_totallyunknowntoken1234567890"),
    ).resolves.toBeUndefined();
  });
});

describe("token_rejected audit", () => {
  test("PKCE mismatch on code exchange emits mcp_oauth.token_rejected row", async () => {
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

    const rows = await db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, "mcp_oauth.token_rejected")))
      .limit(10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const reasons = rows.map((r) => (r.metadata as Record<string, unknown>).reason);
    expect(reasons).toContain("pkce_mismatch");
  });

  test("unknown code exchange emits mcp_oauth.token_rejected row", async () => {
    const beforeCount = (
      await db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, "00000000-0000-0000-0000-000000000000"),
            eq(auditLog.action, "mcp_oauth.token_rejected"),
          ),
        )
        .limit(100)
    ).length;

    let err: unknown;
    try {
      await provider.exchangeAuthorizationCode({
        code: "nonexistent-code-value-abcdef999999",
        codeVerifier: CODE_VERIFIER,
        redirectUri: REDIRECT_URI,
        clientId: "someclientid",
      });
    } catch (e) {
      err = e;
    }
    expect((err as { oauth_error?: string }).oauth_error).toBe("invalid_grant");

    const afterRows = await db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, "00000000-0000-0000-0000-000000000000"),
          eq(auditLog.action, "mcp_oauth.token_rejected"),
        ),
      )
      .limit(100);
    expect(afterRows.length).toBeGreaterThan(beforeCount);
    const reasons = afterRows.map((r) => (r.metadata as Record<string, unknown>).reason);
    expect(reasons).toContain("code_not_found");
  });

  test("unknown refresh token exchange emits mcp_oauth.token_rejected row", async () => {
    const beforeCount = (
      await db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, "00000000-0000-0000-0000-000000000000"),
            eq(auditLog.action, "mcp_oauth.token_rejected"),
          ),
        )
        .limit(100)
    ).length;

    let err: unknown;
    try {
      await provider.exchangeRefreshToken({
        refreshToken: "wf_mcr_nonexistent_refresh_token_abc123",
        clientId: "someclientid",
      });
    } catch (e) {
      err = e;
    }
    expect((err as { oauth_error?: string }).oauth_error).toBe("invalid_grant");

    const afterRows = await db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, "00000000-0000-0000-0000-000000000000"),
          eq(auditLog.action, "mcp_oauth.token_rejected"),
        ),
      )
      .limit(100);
    expect(afterRows.length).toBeGreaterThan(beforeCount);
    const reasons = afterRows.map((r) => (r.metadata as Record<string, unknown>).reason);
    expect(reasons).toContain("refresh_not_found");
  });
});
