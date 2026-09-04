// Integration: `/metrics` requires the `metrics:read` scope — from an API key,
// from an RFC 8693 exchanged token and from a Cockpit connection token alike.
//
// Production measured on 2026-09-04 that a connection token whose grant said
// only `mcp:read` read `/metrics`, because the person who approved the
// connection held the `admin` role and the role bypassed the scope gate. The
// flow tests below mint real connection tokens through register → consent →
// code → token and assert both halves of the rule: `metrics:read` reads,
// `mcp:read` does not.
//
// The regression half matters just as much: an unrestricted (`*` wildcard)
// admin key still scrapes, which is what the production monitoring principal
// and the deploy verify rely on.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CODE_CHALLENGE,
  CODE_VERIFIER,
  mintSessionCookie,
  seedSession,
  setupMcpOauthServer,
  teardownMcpOauthServer,
} from "../../auth/oauth/mcp-oauth-test-helpers.ts";
import { apiKeys, systemAccounts, users } from "../../db/schema/index.ts";
import { generateKey } from "../../identity/api-key.ts";
import { seedBuiltinRolesAndPermissions } from "../../rbac/seed.ts";
import type { HttpTestServer } from "./setup.ts";

const EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const SUBJECT_TYPE = "urn:subkit:params:oauth:token-type:api-key";
const REDIRECT_URI = "https://client.example.com/metrics-cb";
const RESOURCE = "https://test.example.com/mcp";

let ctx: HttpTestServer;
let priorBaseUrl = "";

beforeAll(async () => {
  const s = await setupMcpOauthServer("metrics-scope");
  ctx = s.ctx;
  priorBaseUrl = s.priorBaseUrl;
}, 30_000);

afterAll(async () => {
  await teardownMcpOauthServer(ctx, priorBaseUrl);
}, 30_000);

/** GET /metrics with a bearer credential — status plus the parsed body. */
async function scrape(token: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${ctx.baseUrl}/metrics`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.text() };
}

/** A live key owned by the seeded ADMIN user, carrying exactly `scopes`. */
async function mintUserKey(scopes: string[]): Promise<string> {
  const key = generateKey();
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    prefix: key.prefix,
    token_sha256: key.hash,
    scopes,
  });
  return key.plaintext;
}

/** A live key owned by a fresh, role-less system account. */
async function mintScraperKey(name: string, scopes: string[]): Promise<string> {
  const [account] = await ctx.db
    .insert(systemAccounts)
    .values({ tenant_id: ctx.tenantId, name, description: "scoped scraper" })
    .returning();
  const key = generateKey();
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    system_account_id: account?.id,
    prefix: key.prefix,
    token_sha256: key.hash,
    scopes,
  });
  return key.plaintext;
}

async function exchange(key: string, scope?: string): Promise<string> {
  const form = new URLSearchParams({
    grant_type: EXCHANGE_GRANT,
    subject_token: key,
    subject_token_type: SUBJECT_TYPE,
  });
  if (scope) form.set("scope", scope);
  const res = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!body.access_token) throw new Error(`exchange failed: ${JSON.stringify(body)}`);
  return body.access_token;
}

/**
 * Mint a connection token the way the Cockpit connect flow does: dynamic
 * client registration, a browser session, the rendered consent screen, the
 * operator's tick, the authorization code, the token. Returns the consent
 * HTML too, so a test can assert what the person was actually offered.
 */
async function connect(
  clientName: string,
  scope: string,
): Promise<{ accessToken: string; grantedScope: string; consentHtml: string }> {
  const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: clientName }),
  });
  expect(regRes.status).toBe(201);
  const { client_id: clientId } = (await regRes.json()) as { client_id: string };

  const sessionId = await seedSession(ctx.db, ctx.tenantId, ctx.userId);
  const jwt = await mintSessionCookie({
    session_id: sessionId,
    user_id: ctx.userId,
    tenant_id: ctx.tenantId,
  });

  const authRes = await fetch(
    `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope,
    })}`,
    { headers: { cookie: `subkit_session=${jwt}`, "accept-language": "de" }, redirect: "manual" },
  );
  expect(authRes.status).toBe(200);
  const consentHtml = await authRes.text();
  const csrfToken = consentHtml.match(/name="csrf_token"\s+value="([^"]+)"/)?.[1];
  expect(csrfToken).toBeTruthy();

  const decisionRes = await fetch(`${ctx.baseUrl}/v1/oauth/authorize/decision`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `subkit_session=${jwt}`,
    },
    body: new URLSearchParams({
      csrf_token: csrfToken ?? "",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
      state: "",
      scope,
      decision: "approve",
    }).toString(),
    redirect: "manual",
  });
  expect(decisionRes.status).toBe(302);
  const code = new URL(decisionRes.headers.get("location") ?? "").searchParams.get("code");
  expect(code).not.toBeNull();

  const tokenRes = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code ?? "",
      code_verifier: CODE_VERIFIER,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      resource: RESOURCE,
    }).toString(),
  });
  expect(tokenRes.status).toBe(200);
  const tokens = (await tokenRes.json()) as { access_token: string; scope: string };
  return { accessToken: tokens.access_token, grantedScope: tokens.scope, consentHtml };
}

describe("the metrics scope is offerable", () => {
  test("scopes_supported advertises metrics:read", async () => {
    const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scopes_supported: string[] };
    expect(body.scopes_supported).toContain("metrics:read");
  });

  test("the OpenAPI security description names the scope and the rule", async () => {
    const res = await fetch(`${ctx.baseUrl}/openapi.json`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
      components: {
        securitySchemes: {
          bearerAuth: { description: string };
          oauth2: { flows: { authorizationCode: { scopes: Record<string, string> } } };
        };
      };
    };
    const schemes = spec.components.securitySchemes;
    expect(Object.keys(schemes.oauth2.flows.authorizationCode.scopes)).toContain("metrics:read");
    expect(schemes.bearerAuth.description).toContain("metrics:read");
    expect(schemes.bearerAuth.description).toContain("/metrics");
  });

  test("the consent page offers it with a plain-words German line", async () => {
    const { consentHtml, grantedScope } = await connect("Monitoring Consent", "metrics:read");
    expect(grantedScope).toBe("metrics:read");
    expect(consentHtml).toContain('value="metrics:read"');
    expect(consentHtml).toContain("Betriebszähler lesen");
    // Ticking it and nothing else is a complete consent screen: the flow
    // above returned a token, so the mcp:read entitlement gate did not fire.
    expect(consentHtml).not.toContain('value="mcp:read"');
  });
});

describe("the entitlement gate still gates", () => {
  test("an enduser-role account is offered nothing and the consent flow denies", async () => {
    // The gate was relaxed from "must offer mcp:read" to "must offer
    // something", so that a client asking for `scope=metrics:read` alone gets a
    // usable consent screen. It must not thereby become no gate: `enduser`
    // holds neither `mcp:*` nor `metrics:read`, and is still refused.
    // (`member` DOES hold `metrics:read` — a day-to-day operator may connect a
    // monitoring system; the scope follows the RBAC catalog, not a new rule.)
    const roleIds = await seedBuiltinRolesAndPermissions(ctx.db);
    const [enduser] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "enduser-metrics@test.local",
        role: "enduser",
        role_id: roleIds.enduser,
      })
      .returning();
    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "Enduser Monitoring" }),
    });
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };
    const sessionId = await seedSession(ctx.db, ctx.tenantId, enduser?.id ?? "");
    const jwt = await mintSessionCookie({
      session_id: sessionId,
      user_id: enduser?.id ?? "",
      tenant_id: ctx.tenantId,
    });
    const authRes = await fetch(
      `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        resource: RESOURCE,
        scope: "metrics:read",
      })}`,
      { headers: { cookie: `subkit_session=${jwt}` }, redirect: "manual" },
    );
    expect(authRes.status).toBe(302);
    expect(authRes.headers.get("location") ?? "").toContain("error=access_denied");
  });
});

describe("GET /metrics — API keys", () => {
  test("a key with only metrics:read reads it", async () => {
    const key = await mintScraperKey("metrics-only-scraper", ["metrics:read"]);
    const res = await scrape(key);
    expect(res.status).toBe(200);
    expect(res.body).toContain("# TYPE ");
  });

  test("an admin-owned key without the scope is refused, and the body names it", async () => {
    const key = await mintUserKey(["workflow:read"]);
    const res = await scrape(key);
    expect(res.status).toBe(403);
    expect(res.body).toContain("scope_missing:metrics:read");
  });

  test("regression: an unrestricted (*) admin key still scrapes", async () => {
    const res = await scrape(ctx.apiKey);
    expect(res.status).toBe(200);
    expect(res.body).toContain("# TYPE ");
  });
});

describe("GET /metrics — exchanged tokens (RFC 8693)", () => {
  test("a token exchanged from a metrics:read key reads it", async () => {
    const key = await mintScraperKey("exchange-scraper", ["metrics:read"]);
    const res = await scrape(await exchange(key));
    expect(res.status).toBe(200);
  });

  test("a token narrowed away from the scope is refused", async () => {
    // `connector:read`, not `workflow:read`: a `workflow:<id>` entry in the
    // exchange request narrows the WORKFLOW allowlist, not the scope set
    // (`auth/oauth/token-exchange.ts`), so it would leave the scopes intact.
    const key = await mintScraperKey("exchange-narrow-scraper", ["metrics:read", "connector:read"]);
    const narrowed = await exchange(key, "connector:read");
    const res = await scrape(narrowed);
    expect(res.status).toBe(403);
    expect(res.body).toContain("scope_missing:metrics:read");
  });
});

describe("GET /metrics — connection tokens", () => {
  test("a connection carrying only metrics:read reads it", async () => {
    const { accessToken, grantedScope } = await connect("Monitoring Connection", "metrics:read");
    expect(grantedScope).toBe("metrics:read");
    const res = await scrape(accessToken);
    expect(res.status).toBe(200);
    expect(res.body).toContain("# TYPE ");
  });

  test("the 2026-09-04 defect: a connection carrying only mcp:read is refused", async () => {
    // The approving account is the seeded ADMIN user — exactly the production
    // shape. The grant, not the role, is the answer.
    const { accessToken, grantedScope } = await connect("MCP Read Connection", "mcp:read");
    expect(grantedScope).toBe("mcp:read");
    const res = await scrape(accessToken);
    expect(res.status).toBe(403);
    expect(res.body).toContain("scope_missing:metrics:read");
  });
});
