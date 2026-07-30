// Integration tests for createMcpOAuthAuthProvider.
// Exercises the full resolve() path against a real Postgres DB.
// No mocks — uses testcontainers via createTestDb.
//
// Also covers canonicalizeResourceUri as pure unit tests (no DB needed).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { mcpOauthAccessTokens, mcpOauthClients, tenants, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { generateAccessToken, generateRefreshToken } from "../oauth/tokens.ts";
import { canonicalizeResourceUri, createMcpOAuthAuthProvider } from "./mcp-oauth.ts";

let testDb: TestDb;
let db: Db;
let tenantId: string;
let userId: string;

beforeAll(async () => {
  // Load config once for the whole suite so that resolve()'s audience check
  // can read getConfig().server.public_base_url. The audience describe's
  // beforeAll then overrides only that key via setConfigKey().
  const configDir = await mkdtemp(join(tmpdir(), "sk-mcp-oauth-provider-"));
  await loadConfig({
    env: { DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/subkit" },
    configPathOverride: join(configDir, "subkit.config.json"),
  });
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
  if (testDb) await testDb.cleanup();
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
  /** RFC 8707 resource indicator. Omit only in tests that do not enable audience validation. */
  resource?: string | null;
}): Promise<{ plaintext: string; tokenId: string; clientId: string }> {
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
      // resource: null is the DB default; audience-validation tests pass an
      // explicit value unless they are asserting fail-closed behavior.
      ...(opts?.resource !== undefined ? { resource: opts.resource } : {}),
    })
    .returning({ id: mcpOauthAccessTokens.id });
  if (!row) throw new Error("seed access token failed");
  return { plaintext: token.plaintext, tokenId: row.id, clientId };
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

  test("carries the OAuth client registration the token was issued to", async () => {
    // Which client connected is credential-bound, not self-reported: it comes
    // from the access-token row, so a client cannot claim to be another one the
    // way it can with `clientInfo` at `initialize`. That is what makes it usable
    // for per-channel decisions and for splitting telemetry by client.
    const { plaintext, clientId } = await seedAccessToken();
    const provider = createMcpOAuthAuthProvider({ db, resetThrottle: true });
    const principal = await provider.resolve(makeRequest(plaintext));

    expect(principal?.oauth_client_id).toBe(clientId);
  });

  test("two clients authorised by the same user resolve to different registrations", async () => {
    // The session owner key derives its credential term from this field, so two
    // distinct clients for one user must not collapse onto the same value —
    // otherwise they would share an MCP session.
    const first = await seedAccessToken();
    const second = await seedAccessToken();
    const provider = createMcpOAuthAuthProvider({ db, resetThrottle: true });

    const a = await provider.resolve(makeRequest(first.plaintext));
    const b = await provider.resolve(makeRequest(second.plaintext));

    expect(a?.id).toBe(b?.id ?? "");
    expect(a?.oauth_client_id).not.toBe(b?.oauth_client_id);
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

// ── canonicalizeResourceUri — pure unit tests (no DB) ─────────────────────────

describe("canonicalizeResourceUri", () => {
  test("adds a single trailing slash when path has none", () => {
    expect(canonicalizeResourceUri("https://example.com/mcp")).toBe("https://example.com/mcp/");
  });

  test("normalises multiple trailing slashes to exactly one", () => {
    expect(canonicalizeResourceUri("https://example.com/mcp///")).toBe("https://example.com/mcp/");
  });

  test("preserves a single trailing slash that already exists", () => {
    expect(canonicalizeResourceUri("https://example.com/mcp/")).toBe("https://example.com/mcp/");
  });

  test("lowercases scheme (URL spec normalises on parse)", () => {
    // HTTPS:// → https://
    expect(canonicalizeResourceUri("HTTPS://example.com/mcp")).toBe("https://example.com/mcp/");
  });

  test("lowercases host (URL spec normalises on parse)", () => {
    expect(canonicalizeResourceUri("https://EXAMPLE.COM/mcp")).toBe("https://example.com/mcp/");
  });

  test("handles root path (no path component)", () => {
    expect(canonicalizeResourceUri("https://example.com")).toBe("https://example.com/");
  });
});

// ── Audience (RFC 8707 resource indicator) validation ─────────────────────────

describe("createMcpOAuthAuthProvider — audience validation", () => {
  const TEST_BASE_URL = "https://aud-test.example.com";
  let priorBaseUrl: string;

  beforeAll(async () => {
    priorBaseUrl = getConfig().server.public_base_url;
    await setConfigKey("server.public_base_url", TEST_BASE_URL, { force: true });
  });

  afterAll(async () => {
    await setConfigKey("server.public_base_url", priorBaseUrl, { force: true });
  });

  test("accepts token whose resource matches the server's canonical /mcp URI", async () => {
    // canonicalizeResourceUri("https://aud-test.example.com/mcp") = "https://aud-test.example.com/mcp/"
    const { plaintext } = await seedAccessToken({
      resource: `${TEST_BASE_URL}/mcp`,
    });
    const provider = createMcpOAuthAuthProvider({ db, resetThrottle: true });
    const principal = await provider.resolve(makeRequest(plaintext));
    expect(principal).not.toBeNull();
  });

  test("accepts token with trailing-slash variant of the expected resource", async () => {
    // "https://aud-test.example.com/mcp/" canonicalises to the same value
    const { plaintext } = await seedAccessToken({
      resource: `${TEST_BASE_URL}/mcp/`,
    });
    const provider = createMcpOAuthAuthProvider({ db, resetThrottle: true });
    const principal = await provider.resolve(makeRequest(plaintext));
    expect(principal).not.toBeNull();
  });

  test("rejects token whose resource points to a different server (returns null)", async () => {
    const { plaintext } = await seedAccessToken({
      resource: "https://other-server.example.com/mcp",
    });
    const provider = createMcpOAuthAuthProvider({ db, resetThrottle: true });
    const principal = await provider.resolve(makeRequest(plaintext));
    expect(principal).toBeNull();
  });

  test("rejects a token with null resource", async () => {
    const { plaintext } = await seedAccessToken({ resource: null });
    const provider = createMcpOAuthAuthProvider({ db, resetThrottle: true });
    const principal = await provider.resolve(makeRequest(plaintext));
    expect(principal).toBeNull();
  });

  test("skips audience check when base_url is empty (no rejection)", async () => {
    await setConfigKey("server.public_base_url", "", { force: true });
    try {
      // Even a clearly wrong resource is accepted when base_url is unset
      const { plaintext } = await seedAccessToken({
        resource: "https://completely-wrong.example.com/mcp",
      });
      const provider = createMcpOAuthAuthProvider({ db, resetThrottle: true });
      const principal = await provider.resolve(makeRequest(plaintext));
      expect(principal).not.toBeNull();
    } finally {
      // Restore so subsequent tests in this describe see the test base_url
      await setConfigKey("server.public_base_url", TEST_BASE_URL, { force: true });
    }
  });
});
