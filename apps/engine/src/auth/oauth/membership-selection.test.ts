import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getConfig, setConfigKey } from "../../config/loader.ts";
import {
  authIdentities,
  mcpOauthAuthorizationCodes,
  sessions,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { TEST_DB_HOOK_TIMEOUT } from "../../db/tests/setup.ts";
import type { HttpTestServer } from "../../http/tests/setup.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { now } from "../../utils/clock.ts";
import {
  CODE_CHALLENGE,
  CODE_VERIFIER,
  mintSessionCookie,
  seedSession,
  setupMcpOauthServer,
  teardownMcpOauthServer,
} from "./mcp-oauth-test-helpers.ts";

let ctx: HttpTestServer;
let priorBaseUrl: string;
let selectedTenant: string;
let selectedUser: string;
let identityId: string;
let clientId: string;
let priorLimits: ReturnType<typeof getConfig>["server"]["hosted_rate_limit"];
const redirectUri = "http://127.0.0.1:49152/callback";
const resource = "https://test.example.com/v1/identity/cli-session";

beforeAll(async () => {
  const setup = await setupMcpOauthServer("oauth-membership-selection");
  ctx = setup.ctx;
  await configureHostedPolicyForTests(ctx.db, ctx.testDb.url);
  priorBaseUrl = setup.priorBaseUrl;
  priorLimits = getConfig().server.hosted_rate_limit;
  for (const key of [
    "tenant_per_minute",
    "tenant_per_month",
    "global_per_minute",
    "principal_per_minute",
  ] as const) {
    await setConfigKey(`server.hosted_rate_limit.${key}`, 10000, { force: true });
  }
  const [identity] = await ctx.db
    .insert(authIdentities)
    .values({
      issuer_url: "https://identity.example.test",
      subject: "verified-member",
      email: "member@example.test",
    })
    .returning();
  if (!identity) throw new Error("identity fixture missing");
  identityId = identity.id;
  await ctx.db.update(users).set({ auth_identity_id: identityId }).where(eq(users.id, ctx.userId));
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({
      slug: "owned-workspace",
      display_name: "Owned workspace",
      origin: "self_service",
      owner_identity_id: identityId,
    })
    .returning();
  const [originalUser] = await ctx.db.select().from(users).where(eq(users.id, ctx.userId));
  if (!tenant || !originalUser) throw new Error("workspace fixture missing");
  selectedTenant = tenant.id;
  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id: selectedTenant,
      email: "member@example.test",
      auth_identity_id: identityId,
      role_id: originalUser.role_id,
    })
    .returning();
  if (!member) throw new Error("membership fixture missing");
  selectedUser = member.id;
  const registration = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: "Membership fixture",
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      scope: "subkit:login mcp:read",
    }),
  });
  expect(registration.status).toBe(201);
  clientId = ((await registration.json()) as { client_id: string }).client_id;
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx) {
    for (const [key, value] of Object.entries(priorLimits))
      await setConfigKey(`server.hosted_rate_limit.${key}`, value, { force: true });
    await teardownMcpOauthServer(ctx, priorBaseUrl);
  }
}, TEST_DB_HOOK_TIMEOUT);

async function browserCookie(verified: boolean, tenantId = ctx.tenantId, userId = ctx.userId) {
  const sessionId = await seedSession(ctx.db, tenantId, userId);
  if (verified)
    await ctx.db
      .update(sessions)
      .set({ auth_identity_id: identityId })
      .where(eq(sessions.id, sessionId));
  return `subkit_session=${await mintSessionCookie({ session_id: sessionId, tenant_id: tenantId, user_id: userId })}`;
}

async function authorize(cookie: string, tenantId: string, mcp = false) {
  return fetch(
    `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
      scope: mcp ? "mcp:read" : "subkit:login",
      resource: mcp ? "https://test.example.com/mcp" : resource,
      state: "membership-state",
      tenant_id: tenantId,
    })}`,
    { headers: { cookie }, redirect: "manual" },
  );
}

async function approve(cookie: string, html: string, mcp = false) {
  const csrf = html.match(/name="csrf_token"\s+value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error("missing consent binding");
  return fetch(`${ctx.baseUrl}/v1/oauth/authorize/decision`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrf_token: csrf,
      client_id: clientId,
      redirect_uri: redirectUri,
      resource: mcp ? "https://test.example.com/mcp" : resource,
      state: "membership-state",
      scope: mcp ? "mcp:read" : "subkit:login",
      decision: "approve",
      tenant_id: ctx.tenantId,
    }),
    redirect: "manual",
  });
}

async function exchange(decision: Response) {
  const location = decision.headers.get("location");
  if (!location) throw new Error("missing authorization redirect");
  const code = new URL(location).searchParams.get("code");
  expect(code).toBeTruthy();
  const token = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code ?? "",
      code_verifier: CODE_VERIFIER,
      redirect_uri: redirectUri,
      client_id: clientId,
    }),
  });
  expect(token.status).toBe(200);
  const tokens = (await token.json()) as { access_token: string };
  return fetch(`${ctx.baseUrl}/v1/identity/cli-session`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
}

describe("browser membership authorization", () => {
  test("a verified identity selects its owned workspace and receives only its tenant-bound credential", async () => {
    const cookie = await browserCookie(true);
    const page = await authorize(cookie, selectedTenant);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Owned workspace");
    const response = await exchange(await approve(cookie, html));
    expect(response.status).toBe(200);
    const credential = (await response.json()) as { context_id: string; principal_id: string };
    expect(credential.context_id).toBe(selectedTenant);
    expect(credential.principal_id).toBe(selectedUser);
  });

  test("an accepted invited membership is usable from the owned workspace", async () => {
    const cookie = await browserCookie(true, selectedTenant, selectedUser);
    const page = await authorize(cookie, ctx.tenantId);
    expect(page.status).toBe(200);
    const response = await exchange(await approve(cookie, await page.text()));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { context_id: string }).context_id).toBe(ctx.tenantId);
  });

  test("MCP consent binds the selected membership, resource and PKCE challenge", async () => {
    const cookie = await browserCookie(true);
    const page = await authorize(cookie, selectedTenant, true);
    expect(page.status).toBe(200);
    const decision = await approve(cookie, await page.text(), true);
    const code = new URL(decision.headers.get("location") ?? "").searchParams.get("code");
    expect(code).toBeTruthy();
    const [grant] = await ctx.db
      .select()
      .from(mcpOauthAuthorizationCodes)
      .where(
        eq(
          mcpOauthAuthorizationCodes.code_sha256,
          createHash("sha256")
            .update(code ?? "")
            .digest("hex"),
        ),
      );
    expect(grant?.tenant_id).toBe(selectedTenant);
    expect(grant?.user_id).toBe(selectedUser);
    expect(grant?.resource).toBe("https://test.example.com/mcp");
    expect(grant?.scope).toBe("mcp:read");
    expect(grant?.code_challenge).toBe(CODE_CHALLENGE);
  });

  test("an API-key-origin browser session cannot turn a tenant hint into global identity", async () => {
    const page = await authorize(await browserCookie(false), selectedTenant);
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toContain("error=access_denied");
  });

  test("a revoked target membership cannot consume an earlier consent", async () => {
    const cookie = await browserCookie(true);
    const page = await authorize(cookie, selectedTenant);
    expect(page.status).toBe(200);
    await ctx.db.update(users).set({ status: "disabled" }).where(eq(users.id, selectedUser));
    try {
      const denied = await approve(cookie, await page.text());
      expect(denied.headers.get("location")).toContain("error=access_denied");
      const [browser] = await ctx.db
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, ctx.userId));
      expect(browser?.status).toBe("active");
    } finally {
      await ctx.db
        .update(users)
        .set({ status: "active", updated_at: new Date(now()) })
        .where(eq(users.id, selectedUser));
    }
  });
});
