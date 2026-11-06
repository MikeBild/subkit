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
