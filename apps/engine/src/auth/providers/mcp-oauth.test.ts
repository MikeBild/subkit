import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../../audit/audit.ts";
import { queryAuditLog, serializeAuditEntry } from "../../audit/query.ts";
import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { mcpOauthAccessTokens, mcpOauthClients, tenants, users } from "../../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../db/tests/setup.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { generateAccessToken, generateRefreshToken } from "../oauth/tokens.ts";
import { canonicalizeResourceUri, createMcpOAuthAuthProvider } from "./mcp-oauth.ts";

let testDb: TestDb;
let db: Db;
let tenantId: string;
let userId: string;

beforeAll(async () => {
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
    .values({
      tenant_id: tenantId,
      email: "mcp-auth@test.local",
      role_id: await builtinRoleId(db, "admin"),
    })
    .returning();
  if (!u) throw new Error("seed user failed");
  userId = u.id;
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  if (testDb) await testDb.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

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

async function seedAccessToken(opts?: {
  scope?: string;
  tenantIdOverride?: string;
  userIdOverride?: string;
  expiresAt?: Date;
  revokedAt?: Date;
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
    const { plaintext, clientId } = await seedAccessToken();
    const provider = createMcpOAuthAuthProvider({ db, resetThrottle: true });
    const principal = await provider.resolve(makeRequest(plaintext));

    expect(principal?.oauth_client_id).toBe(clientId);
  });

  test("first token use is filterable by its verified OAuth client", async () => {
    const { plaintext, tokenId, clientId } = await seedAccessToken();
    const provider = createMcpOAuthAuthProvider({ db, resetThrottle: true });
    expect(await provider.resolve(makeRequest(plaintext))).not.toBeNull();
    await _drainAuditWritesForTests(db);
    const receipts = await queryAuditLog(db, {
      tenant_id: tenantId,
      oauth_client_id: clientId,
      actions: ["mcp_oauth.token_used"],
    });
    expect(receipts.items.map((item) => item.resource_id)).toContain(tokenId);
    const receipt = receipts.items.find((item) => item.resource_id === tokenId);
    expect(serializeAuditEntry(receipt!).oauth_client_id).toBe(clientId);
  });

  test("two clients authorised by the same user resolve to different registrations", async () => {
    const first = await seedAccessToken();
    const second = await seedAccessToken();
    const provider = createMcpOAuthAuthProvider({ db, resetThrottle: true });

    const a = await provider.resolve(makeRequest(first.plaintext));
    const b = await provider.resolve(makeRequest(second.plaintext));

    expect(a?.id).toBe(b?.id ?? "");
    expect(a?.oauth_client_id).not.toBe(b?.oauth_client_id);
  });
});

describe("createMcpOAuthAuthProvider — prefix rejection", () => {
  test("Bearer wf_live_* prefix returns null (falls through)", async () => {
    const provider = createMcpOAuthAuthProvider({ db });
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

describe("createMcpOAuthAuthProvider — last_used_at flush throttling", () => {
  test("two resolve() calls within 60s only update last_used_at once", async () => {
    const { plaintext, tokenId } = await seedAccessToken({ scope: "mcp:read" });
    const provider = createMcpOAuthAuthProvider({ db, resetThrottle: true });

    await provider.resolve(makeRequest(plaintext));

    const rows1 = await db
      .select({ last_used_at: mcpOauthAccessTokens.last_used_at })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.id, tokenId))
      .limit(1);
    const firstFlushTs = rows1[0]?.last_used_at;
    expect(firstFlushTs).not.toBeNull();

    await provider.resolve(makeRequest(plaintext));

    const rows2 = await db
      .select({ last_used_at: mcpOauthAccessTokens.last_used_at })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.id, tokenId))
      .limit(1);
    const secondFlushTs = rows2[0]?.last_used_at;

    expect(secondFlushTs?.getTime()).toBe(firstFlushTs?.getTime());
  });
});

describe("createMcpOAuthAuthProvider — tenant isolation", () => {
  test("token for tenant A resolves to a principal whose tenant_id is A", async () => {
    const [tenantB] = await db
      .insert(tenants)
      .values({ slug: "mcp-tenant-b", display_name: "Tenant B" })
      .returning();
    if (!tenantB) throw new Error("seed tenant B failed");

    const [userB] = await db
      .insert(users)
      .values({
        tenant_id: tenantB.id,
        email: "user-b@test.local",
        role_id: await builtinRoleId(db, "member"),
      })
      .returning();
    if (!userB) throw new Error("seed user B failed");

    const { plaintext } = await seedAccessToken({ scope: "mcp:read" });

    const provider = createMcpOAuthAuthProvider({ db });
    const principal = await provider.resolve(makeRequest(plaintext));

    expect(principal).not.toBeNull();
    expect(principal?.tenant_id).toBe(tenantId);
    expect(principal?.tenant_id).not.toBe(tenantB.id);
  });
});

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
    expect(canonicalizeResourceUri("HTTPS://example.com/mcp")).toBe("https://example.com/mcp/");
  });

  test("lowercases host (URL spec normalises on parse)", () => {
    expect(canonicalizeResourceUri("https://EXAMPLE.COM/mcp")).toBe("https://example.com/mcp/");
  });

  test("handles root path (no path component)", () => {
    expect(canonicalizeResourceUri("https://example.com")).toBe("https://example.com/");
  });
});

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
    const { plaintext } = await seedAccessToken({
      resource: `${TEST_BASE_URL}/mcp`,
    });
    const provider = createMcpOAuthAuthProvider({ db, resetThrottle: true });
    const principal = await provider.resolve(makeRequest(plaintext));
    expect(principal).not.toBeNull();
  });

  test("accepts token with trailing-slash variant of the expected resource", async () => {
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
      const { plaintext } = await seedAccessToken({
        resource: "https://completely-wrong.example.com/mcp",
      });
      const provider = createMcpOAuthAuthProvider({ db, resetThrottle: true });
      const principal = await provider.resolve(makeRequest(plaintext));
      expect(principal).not.toBeNull();
    } finally {
      await setConfigKey("server.public_base_url", TEST_BASE_URL, { force: true });
    }
  });
});
