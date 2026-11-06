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
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { createMcpOAuthProvider, type McpOAuthProvider } from "./server-provider.ts";
import { serverProviderFixtures } from "./server-provider-fixtures.ts";
import { sha256Hex } from "./tokens.ts";

const { issueTokenPair, makeConfig, registerTestClient } = serverProviderFixtures({
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
