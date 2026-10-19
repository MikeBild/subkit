import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getConfig } from "../../config/loader.ts";
import { ConfigSchema } from "../../config/schema.ts";
import { sessions, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createSession, issueApiKey, provisionSelfServiceTenant } from "../../identity/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { issueBrowserSession } from "../browser-session.ts";
import { consumeCliLoginToken } from "./cli-session.ts";
import { CLI_LOGIN_SCOPE } from "./resources.ts";
import { createMcpOAuthProvider, type McpOAuthProvider } from "./server-provider.ts";
import { API_KEY_TOKEN_TYPE, exchangeApiKeyForToken } from "./token-exchange.ts";

let ctx: TestDb;
let tenantId: string;
let userId: string;
let provider: McpOAuthProvider;
let clientId: string;
let apiKey: string;
const baseUrl = "https://engine.example.test";
const redirectUri = "https://client.example.test/callback";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = createHash("sha256").update(verifier).digest("base64url");
beforeAll(async () => {
  ctx = await createTestDb("oauth-tenant-status");
  await configureHostedPolicyForTests(ctx.db, ctx.url);
  const fixture = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: "oauth-mint-status",
      email: "owner@example.test",
      email_verified: true,
    },
    ctx.db,
  );
  tenantId = fixture.tenant.id;
  userId = fixture.membership.user_id;
  const config = ConfigSchema.parse({
    auth: {
      session: { secret: getConfig().auth.session.secret },
      hosted: { admission: getConfig().auth.hosted.admission },
    },
    database: { url: ctx.url },
    server: { public_base_url: baseUrl },
  });
  provider = createMcpOAuthProvider({ db: ctx.db, config });
  clientId = (await provider.registerClient({ redirect_uris: [redirectUri], scope: "mcp:read" }))
    .client_id;
  apiKey = (
    await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        owner_kind: "user",
        owner_id: userId,
        actor: { kind: "system", id: null },
        scopes: ["*"],
      },
      ctx.db,
    )
  ).plaintext;
});
afterAll(async () => {
  if (ctx) await ctx.cleanup();
});
async function code(scope = "mcp:read", resource?: string) {
  return provider.issueAuthorizationCode({
    tenantId,
    userId,
    clientId,
    redirectUri,
    scope,
    codeChallenge: challenge,
    ...(resource ? { resource } : {}),
  });
}
async function pair(scope = "mcp:read", resource?: string) {
  const authorizationCode = await code(scope, resource);
  return provider.exchangeAuthorizationCode({
    code: authorizationCode,
    clientId,
    redirectUri,
    codeVerifier: verifier,
  });
}

test("suspended tenants cannot issue authorization codes, browser sessions, keys or exchanged tokens", async () => {
  await ctx.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, tenantId));
  try {
    await expect(code()).rejects.toMatchObject({ oauth_error: "invalid_grant" });
    expect(
      (
        await issueBrowserSession({
          db: ctx.db,
          tenantId,
          userId,
          redirectTo: "/cockpit",
          via: "test",
        })
      ).status,
    ).toBe(403);
    await expect(createSession({ tenant_id: tenantId, user_id: userId }, ctx.db)).rejects.toThrow(
      "tenant_unavailable",
    );
    await expect(
      issueApiKey(
        {
          issuer: { kind: "system" },
          tenant_id: tenantId,
          owner_kind: "user",
          owner_id: userId,
          actor: { kind: "system", id: null },
        },
        ctx.db,
      ),
    ).rejects.toThrow("tenant_unavailable");
    await expect(
      exchangeApiKeyForToken({
        db: ctx.db,
        subjectToken: apiKey,
        subjectTokenType: API_KEY_TOKEN_TYPE,
        requestSource: "api",
      }),
    ).rejects.toMatchObject({ oauth_error: "invalid_grant" });
    expect(
      await ctx.db.select().from(sessions).where(eq(sessions.tenant_id, tenantId)),
    ).toHaveLength(0);
  } finally {
    await ctx.db
      .update(tenants)
      .set({ status: "active", deletion_requested_at: null, deletion_scheduled_for: null })
      .where(eq(tenants.id, tenantId));
  }
});

test("codes, refresh tokens and CLI login grants stop after suspension or pending deletion", async () => {
  for (const status of ["suspended", "pending_deletion"] as const) {
    const authorizationCode = await code();
    const tokens = await pair();
    const cli = await pair(CLI_LOGIN_SCOPE, `${baseUrl}/v1/identity/cli-session`);
    await ctx.db
      .update(tenants)
      .set({
        status,
        ...(status === "pending_deletion"
          ? {
              deletion_requested_at: new Date(getTestNow()),
              deletion_scheduled_for: new Date(getTestNow() + 86_400_000),
            }
          : {}),
      })
      .where(eq(tenants.id, tenantId));
    try {
      await expect(
        provider.exchangeAuthorizationCode({
          code: authorizationCode,
          clientId,
          redirectUri,
          codeVerifier: verifier,
        }),
      ).rejects.toMatchObject({ oauth_error: "invalid_grant" });
      await expect(
        provider.exchangeRefreshToken({ refreshToken: tokens.refresh_token, clientId }),
      ).rejects.toMatchObject({ oauth_error: "invalid_grant" });
      expect(
        await consumeCliLoginToken({
          db: ctx.db,
          token: cli.access_token,
          publicBaseUrl: baseUrl,
          requestSource: "cli",
        }),
      ).toEqual({ ok: false, error: "invalid_token" });
    } finally {
      await ctx.db
        .update(tenants)
        .set({ status: "active", deletion_requested_at: null, deletion_scheduled_for: null })
        .where(eq(tenants.id, tenantId));
    }
  }
});
