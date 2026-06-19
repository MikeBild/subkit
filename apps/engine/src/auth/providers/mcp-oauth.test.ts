// Integration tests for createMcpOAuthAuthProvider.
// Exercises the full resolve() path against a real Postgres DB.
// No mocks — uses testcontainers via createTestDb.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { mcpOauthAccessTokens, mcpOauthClients, tenants, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { generateAccessToken, generateRefreshToken } from "../oauth/tokens.ts";
import { createMcpOAuthAuthProvider } from "./mcp-oauth.ts";

let testDb: TestDb;
let db: Db;
let tenantId: string;
let userId: string;

beforeAll(async () => {
  testDb = await createTestDb("mcp-oauth-auth-provider");
  db = testDb.db;

  const [t] = await db
    .insert(tenants)
    .values({ slug: "mcp-auth-prov", display_name: "MCP Auth Provider Test" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenantId = t.id;

  const [u] = await db
    .insert(users)
    .values({ tenant_id: tenantId, email: "mcp-auth@test.local", role: "admin" })
    .returning();
  if (!u) throw new Error("seed user failed");
  userId = u.id;
}, 30_000);

afterAll(async () => {
  await testDb.cleanup();
}, 30_000);

// Seed a DCR client row so the access token FK resolves
let clientSeq = 0;
async function seedClient(): Promise<string> {
  const clientId = `test-client-${++clientSeq}`;
  await db.insert(mcpOauthClients).values({
    client_id: clientId,
    redirect_uris: ["https://test.example.com/cb"],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
    scope: "mcp:read",
    registration_source: "dcr",
  });
  return clientId;
}

// Seed a valid access token and return its plaintext
async function seedAccessToken(opts?: {
  scope?: string;
  tenantIdOverride?: string;
  userIdOverride?: string;
  expiresAt?: Date;
  revokedAt?: Date;
}): Promise<{ plaintext: string; tokenId: string }> {
  const clientId = await seedClient();
  const token = generateAccessToken();
  const now = new Date(); // allow-wall-clock
  const expiresAt = opts?.expiresAt ?? new Date(now.getTime() + 3_600_000);

  const [row] = await db
    .insert(mcpOauthAccessTokens)
    .values({
      tenant_id: opts?.tenantIdOverride ?? tenantId,
      client_id: clientId,
      user_id: opts?.userIdOverride ?? userId,
      prefix: token.prefix,
      token_sha256: token.hash,
      scope: opts?.scope ?? "mcp:read",
      expires_at: expiresAt,
      revoked_at: opts?.revokedAt ?? null,
    })
    .returning({ id: mcpOauthAccessTokens.id });
  if (!row) throw new Error("seed access token failed");
  return { plaintext: token.plaintext, tokenId: row.id };
}

function makeRequest(token: string): Request {
  return new Request("http://localhost/mcp", {
    headers: { authorization: `Bearer ${token}` },
  });
}

// ── Happy path ────────────────────────────────────────────────────────────────

describe("createMcpOAuthAuthProvider — happy path", () => {
  test("valid wf_mcp_* token resolves to ResolvedPrincipal with correct tenant_id, scopes, roles, kind", async () => {
    const { plaintext } = await seedAccessToken({ scope: "mcp:read mcp:authoring" });
    const provider = createMcpOAuthAuthProvider({ db, resetThrottle: true });
    const principal = await provider.resolve(makeRequest(plaintext));

    expect(principal).not.toBeNull();
    expect(principal?.kind).toBe("user");
    expect(principal?.tenant_id).toBe(tenantId);
    expect(principal?.scopes).toContain("mcp:read");
    expect(principal?.scopes).toContain("mcp:authoring");
    expect(Array.isArray(principal?.roles)).toBe(true);
    expect((principal?.roles ?? []).length).toBeGreaterThan(0);
  });
});

// ── Prefix rejection ──────────────────────────────────────────────────────────

describe("createMcpOAuthAuthProvider — prefix rejection", () => {
  test("Bearer wf_live_* prefix returns null (falls through)", async () => {
    const provider = createMcpOAuthAuthProvider({ db });
    // wf_live_ prefix is used for API keys, not MCP OAuth tokens
    const principal = await provider.resolve(
      makeRequest("wf_live_abcdefghijklmnopqrstuvwxyz01234567"),
    );
    expect(principal).toBeNull();
  });

  test("Bearer wf_mcr_* prefix returns null (refresh token not accepted as Bearer)", async () => {
    const provider = createMcpOAuthAuthProvider({ db });
    const refreshToken = generateRefreshToken();
    const principal = await provider.resolve(makeRequest(refreshToken.plaintext));
    expect(principal).toBeNull();
  });
});

// ── Revocation + expiry ───────────────────────────────────────────────────────

describe("createMcpOAuthAuthProvider — revocation and expiry", () => {
  test("revoked token (revoked_at in the past) returns null", async () => {
    const { plaintext } = await seedAccessToken({
      revokedAt: new Date(Date.now() - 5_000), // allow-wall-clock
    });
    const provider = createMcpOAuthAuthProvider({ db });
    const principal = await provider.resolve(makeRequest(plaintext));
    expect(principal).toBeNull();
  });

  test("expired token (expires_at in the past) returns null", async () => {
    const { plaintext } = await seedAccessToken({
      expiresAt: new Date(Date.now() - 10_000), // allow-wall-clock
    });
    const provider = createMcpOAuthAuthProvider({ db });
    const principal = await provider.resolve(makeRequest(plaintext));
    expect(principal).toBeNull();
  });
});

// ── last_used_at flush throttling ─────────────────────────────────────────────

describe("createMcpOAuthAuthProvider — last_used_at flush throttling", () => {
  test("two resolve() calls within 60s only update last_used_at once", async () => {
    const { plaintext, tokenId } = await seedAccessToken({ scope: "mcp:read" });
    // resetThrottle clears the module-level lastFlush map so this token starts cold
    const provider = createMcpOAuthAuthProvider({ db, resetThrottle: true });

    // First call — should write last_used_at. The flush is awaited
    // inside resolve(), so the row is updated before resolve() returns.
    await provider.resolve(makeRequest(plaintext));

    const rows1 = await db
      .select({ last_used_at: mcpOauthAccessTokens.last_used_at })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.id, tokenId))
      .limit(1);
    const firstFlushTs = rows1[0]?.last_used_at;
    expect(firstFlushTs).not.toBeNull();

    // Second call immediately after — should NOT update (within 60s window)
    await provider.resolve(makeRequest(plaintext));

    const rows2 = await db
      .select({ last_used_at: mcpOauthAccessTokens.last_used_at })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.id, tokenId))
      .limit(1);
    const secondFlushTs = rows2[0]?.last_used_at;

    // The timestamp must not have changed (same flush window)
    expect(secondFlushTs?.getTime()).toBe(firstFlushTs?.getTime());
  });
});

// ── Tenant isolation ──────────────────────────────────────────────────────────

describe("createMcpOAuthAuthProvider — tenant isolation", () => {
  test("token for tenant A resolves to a principal whose tenant_id is A", async () => {
    // Seed a second tenant
    const [tenantB] = await db
      .insert(tenants)
      .values({ slug: "mcp-tenant-b", display_name: "Tenant B" })
      .returning();
    if (!tenantB) throw new Error("seed tenant B failed");

    const [userB] = await db
      .insert(users)
      .values({ tenant_id: tenantB.id, email: "user-b@test.local", role: "member" })
      .returning();
    if (!userB) throw new Error("seed user B failed");

    // Issue a token scoped to tenantId (A)
    const { plaintext } = await seedAccessToken({ scope: "mcp:read" });

    const provider = createMcpOAuthAuthProvider({ db });
    const principal = await provider.resolve(makeRequest(plaintext));

    expect(principal).not.toBeNull();
    // The principal's tenant_id must be A (not B)
    expect(principal?.tenant_id).toBe(tenantId);
    expect(principal?.tenant_id).not.toBe(tenantB.id);
  });
});
