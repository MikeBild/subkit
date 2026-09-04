import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../../audit/index.ts";
import { generateAccessToken, generateRefreshToken } from "../../../auth/oauth/tokens.ts";
import { getConfig, setConfigKey } from "../../../config/loader.ts";
import {
  apiKeys,
  auditLog,
  mcpOauthAccessTokens,
  mcpOauthRefreshTokens,
  users,
} from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let ctx: HttpTestServer;
let priorBaseUrl = "";
const publicBaseUrl = "https://identity.example.test";

beforeAll(async () => {
  ctx = await createHttpTestServer("cli-session");
  priorBaseUrl = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", publicBaseUrl, { force: true });
});

afterAll(async () => {
  await setConfigKey("server.public_base_url", priorBaseUrl, { force: true });
  await ctx.cleanup();
});

async function seedOAuthToken(input: { scope?: string; resource?: string; withRefresh?: boolean }) {
  const access = generateAccessToken();
  const refresh = generateRefreshToken();
  const expiresAt = new Date(Date.now() + 60_000); // allow-wall-clock
  let refreshTokenId: string | null = null;
  if (input.withRefresh) {
    const [row] = await ctx.db
      .insert(mcpOauthRefreshTokens)
      .values({
        tenant_id: ctx.tenantId,
        client_id: "sk-cli-test",
        user_id: ctx.userId,
        prefix: refresh.prefix,
        token_sha256: refresh.hash,
        scope: input.scope ?? "sk:login",
        resource: input.resource ?? `${publicBaseUrl}/v1/identity/cli-session`,
        expires_at: expiresAt,
      })
      .returning({ id: mcpOauthRefreshTokens.id });
    refreshTokenId = row?.id ?? null;
  }
  const [row] = await ctx.db
    .insert(mcpOauthAccessTokens)
    .values({
      tenant_id: ctx.tenantId,
      client_id: "sk-cli-test",
      user_id: ctx.userId,
      prefix: access.prefix,
      token_sha256: access.hash,
      scope: input.scope ?? "sk:login",
      resource: input.resource ?? `${publicBaseUrl}/v1/identity/cli-session`,
      refresh_token_id: refreshTokenId,
      expires_at: expiresAt,
    })
    .returning({ id: mcpOauthAccessTokens.id });
  if (!row) throw new Error("failed to seed OAuth access token");
  return { access: access.plaintext, accessId: row.id, refreshTokenId };
}

async function exchange(token: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}/v1/identity/cli-session`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "user-agent": "sk-cli/test" },
  });
}

describe("POST /v1/identity/cli-session", () => {
  test("requires a dedicated OAuth bearer credential", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/cli-session`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="sk-cli"');
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("rejects an MCP-audience token and MCP rejects a CLI-audience token", async () => {
    const mcpToken = await seedOAuthToken({ resource: `${publicBaseUrl}/mcp`, scope: "mcp:read" });
    expect((await exchange(mcpToken.access)).status).toBe(401);

    const cliToken = await seedOAuthToken({});
    const mcpRes = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken.access}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(mcpRes.status).toBe(401);
  });

  test("returns 403 when the dedicated audience lacks the exact sk:login scope", async () => {
    const seeded = await seedOAuthToken({ scope: "mcp:read" });
    expect((await exchange(seeded.access)).status).toBe(403);
  });

  test("atomically consumes the OAuth family and issues one personal API key", async () => {
    const beforeKeys = await ctx.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenant_id, ctx.tenantId), eq(apiKeys.user_id, ctx.userId)));
    const seeded = await seedOAuthToken({ withRefresh: true });

    const res = await exchange(seeded.access);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      api_key: string;
      principal_id: string;
      context_id: string;
      email: string;
    };
    expect(body.api_key).toMatch(/^wf_live_/);
    expect(body.principal_id).toBe(ctx.userId);
    expect(body.context_id).toBe(ctx.tenantId);

    const [accessRow] = await ctx.db
      .select({ revoked_at: mcpOauthAccessTokens.revoked_at })
      .from(mcpOauthAccessTokens)
      .where(
        and(
          eq(mcpOauthAccessTokens.id, seeded.accessId),
          eq(mcpOauthAccessTokens.tenant_id, ctx.tenantId),
        ),
      );
    expect(accessRow?.revoked_at).toBeInstanceOf(Date);
    if (!seeded.refreshTokenId) throw new Error("expected linked refresh token");
    const [refreshRow] = await ctx.db
      .select({ revoked_at: mcpOauthRefreshTokens.revoked_at })
      .from(mcpOauthRefreshTokens)
      .where(
        and(
          eq(mcpOauthRefreshTokens.id, seeded.refreshTokenId),
          eq(mcpOauthRefreshTokens.tenant_id, ctx.tenantId),
        ),
      );
    expect(refreshRow?.revoked_at).toBeInstanceOf(Date);

    const afterKeys = await ctx.db
      .select({ id: apiKeys.id, name: apiKeys.name })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenant_id, ctx.tenantId), eq(apiKeys.user_id, ctx.userId)));
    expect(afterKeys).toHaveLength(beforeKeys.length + 1);
    expect(afterKeys.some((key) => key.name === "SubKit CLI")).toBe(true);
    const [loginAudit] = await ctx.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, AuditAction.SK_CLI_LOGIN)),
      )
      .limit(1);
    expect(loginAudit?.action).toBe(AuditAction.SK_CLI_LOGIN);

    expect((await exchange(seeded.access)).status).toBe(401);
    const replayKeys = await ctx.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenant_id, ctx.tenantId), eq(apiKeys.user_id, ctx.userId)));
    expect(replayKeys).toHaveLength(afterKeys.length);
  });

  test("does not mint a key for an inactive account", async () => {
    const seeded = await seedOAuthToken({});
    await ctx.db
      .update(users)
      .set({ status: "disabled" })
      .where(and(eq(users.id, ctx.userId), eq(users.tenant_id, ctx.tenantId)));
    expect((await exchange(seeded.access)).status).toBe(401);
    await ctx.db
      .update(users)
      .set({ status: "active" })
      .where(and(eq(users.id, ctx.userId), eq(users.tenant_id, ctx.tenantId)));
    expect((await exchange(seeded.access)).status).toBe(401);
    const [spent] = await ctx.db
      .select({ revoked_at: mcpOauthAccessTokens.revoked_at })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.id, seeded.accessId));
    expect(spent?.revoked_at).toBeInstanceOf(Date);
  });
});
