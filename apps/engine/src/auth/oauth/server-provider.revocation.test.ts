import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
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
import { revokeOAuthRefreshTokenFamily } from "./refresh-token-revocation.ts";
import { createMcpOAuthProvider, type McpOAuthProvider } from "./server-provider.ts";
import { CODE_VERIFIER, REDIRECT_URI, serverProviderFixtures } from "./server-provider-fixtures.ts";
import { sha256Hex } from "./tokens.ts";

const { CODE_CHALLENGE, issueTokenPair, makeConfig, registerTestClient } = serverProviderFixtures({
  get testDb() {
    return testDb;
  },
  get provider() {
    return provider;
  },
  get tenantId() {
    return tenantId;
  },
  get userId() {
    return userId;
  },
});

let testDb: TestDb;

let db: Db;

let tenantId: string;

let userId: string;

let provider: McpOAuthProvider;

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
