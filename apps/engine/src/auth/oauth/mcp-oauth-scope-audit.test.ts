import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { auditLog, sessions, users } from "../../db/schema/index.ts";
import { TEST_DB_HOOK_TIMEOUT } from "../../db/tests/setup.ts";
import type { HttpTestServer } from "../../http/tests/setup.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import {
  CODE_CHALLENGE,
  CODE_VERIFIER,
  mintSessionCookie,
  seedSession,
  setupMcpOauthServer,
  teardownMcpOauthServer,
} from "./mcp-oauth-test-helpers.ts";

let ctx: HttpTestServer;
let db: Db;
let priorBaseUrl = "";

beforeEach(async () => {
  const s = await setupMcpOauthServer("mcp-oauth-scope-audit");
  ctx = s.ctx;
  db = ctx.db;
  priorBaseUrl = s.priorBaseUrl;
}, TEST_DB_HOOK_TIMEOUT);

afterEach(async () => {
  if (ctx) await teardownMcpOauthServer(ctx, priorBaseUrl);
}, TEST_DB_HOOK_TIMEOUT);

describe("unauthenticated POST /mcp", () => {
  test("returns 401 with WWW-Authenticate: Bearer resource_metadata= header", async () => {
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("resource_metadata=");
  });
});

describe("consent denial", () => {
  test("deny redirects to redirect_uri with error=access_denied", async () => {
    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example.com/deny-cb"] }),
    });
    expect(regRes.status).toBe(201);
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    const sessionId = await seedSession(db, ctx.tenantId, ctx.userId);
    const jwt = await mintSessionCookie({
      session_id: sessionId,
      user_id: ctx.userId,
      tenant_id: ctx.tenantId,
    });

    const authRes = await fetch(
      `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://client.example.com/deny-cb",
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        scope: "mcp:read",
        state: "deny-state",
      })}`,
      { headers: { cookie: `subkit_session=${jwt}` }, redirect: "manual" },
    );
    const html = await authRes.text();
    const csrfMatch = html.match(/name="csrf_token"\s+value="([^"]+)"/);
    expect(csrfMatch).not.toBeNull();
    const csrfToken = csrfMatch![1] as string;

    const denialRes = await fetch(`${ctx.baseUrl}/v1/oauth/authorize/decision`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `subkit_session=${jwt}`,
      },
      body: new URLSearchParams({
        csrf_token: csrfToken,
        client_id: clientId,
        redirect_uri: "https://client.example.com/deny-cb",
        resource: "https://test.example.com/mcp",
        state: "deny-state",
        decision: "deny",
      }).toString(),
      redirect: "manual",
    });
    expect(denialRes.status).toBe(302);
    const location = denialRes.headers.get("location") ?? "";
    expect(location).toContain("error=access_denied");
    expect(location).toContain("state=deny-state");
  });

  test("session revoked between consent render and decision returns 401", async () => {
    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example.com/revoke-cb"] }),
    });
    expect(regRes.status).toBe(201);
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    const sessionId = await seedSession(db, ctx.tenantId, ctx.userId);
    const jwt = await mintSessionCookie({
      session_id: sessionId,
      user_id: ctx.userId,
      tenant_id: ctx.tenantId,
    });

    const authRes = await fetch(
      `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://client.example.com/revoke-cb",
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        scope: "mcp:read",
      })}`,
      { headers: { cookie: `subkit_session=${jwt}` }, redirect: "manual" },
    );
    const html = await authRes.text();
    const csrfToken = html.match(/name="csrf_token"\s+value="([^"]+)"/)?.[1] as string;
    expect(csrfToken).toBeDefined();

    await db
      .update(sessions)
      .set({ revoked_at: new Date() }) // allow-wall-clock
      .where(eq(sessions.id, sessionId));

    const decisionRes = await fetch(`${ctx.baseUrl}/v1/oauth/authorize/decision`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `subkit_session=${jwt}`,
      },
      body: new URLSearchParams({
        csrf_token: csrfToken,
        client_id: clientId,
        redirect_uri: "https://client.example.com/revoke-cb",
        resource: "https://test.example.com/mcp",
        state: "",
        scope: "mcp:read",
        decision: "approve",
      }).toString(),
      redirect: "manual",
    });
    expect(decisionRes.status).toBe(401);
  });

  test("absolute session expiry forces a fresh browser login", async () => {
    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example.com/expired-cb"] }),
    });
    expect(regRes.status).toBe(201);
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };
    const sessionId = await seedSession(db, ctx.tenantId, ctx.userId);
    const jwt = await mintSessionCookie({
      session_id: sessionId,
      user_id: ctx.userId,
      tenant_id: ctx.tenantId,
    });
    await db
      .update(sessions)
      .set({ absolute_expires_at: new Date(Date.now() - 1_000) }) // allow-wall-clock
      .where(eq(sessions.id, sessionId));

    const res = await fetch(
      `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://client.example.com/expired-cb",
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        scope: "mcp:read",
      })}`,
      { headers: { cookie: `subkit_session=${jwt}` }, redirect: "manual" },
    );

    expect(res.status).toBe(302);
    const loginLocation = new URL(res.headers.get("location") ?? "");
    expect(loginLocation.pathname).toBe("/v1/identity/login/start");
    expect(loginLocation.searchParams.get("login_state")).toBeTruthy();
    expect(loginLocation.searchParams.has("redirect_to")).toBe(false);
  });
});

describe("scope intersection — role-based scope restriction", () => {
  test("member role requesting mcp:admin receives token without mcp:admin", async () => {
    const [memberUser] = await db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "member-scope@test.local",
        role_id: await builtinRoleId(db, "member"),
      })
      .returning();
    if (!memberUser) throw new Error("seed member user failed");

    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://member.example.com/cb"] }),
    });
    expect(regRes.status).toBe(201);
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    const sessionId = await seedSession(db, ctx.tenantId, memberUser.id);
    const jwt = await mintSessionCookie({
      session_id: sessionId,
      user_id: memberUser.id,
      tenant_id: ctx.tenantId,
    });

    const authRes = await fetch(
      `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://member.example.com/cb",
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        scope: "mcp:read mcp:admin",
      })}`,
      { headers: { cookie: `subkit_session=${jwt}` }, redirect: "manual" },
    );
    expect(authRes.status).toBe(200);
    const html = await authRes.text();
    expect(html).not.toContain('value="mcp:admin"');

    const csrfMatch = html.match(/name="csrf_token"\s+value="([^"]+)"/);
    expect(csrfMatch).not.toBeNull();
    const csrfToken = csrfMatch![1] as string;

    const decisionRes = await fetch(`${ctx.baseUrl}/v1/oauth/authorize/decision`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `subkit_session=${jwt}`,
      },
      body: new URLSearchParams({
        csrf_token: csrfToken,
        client_id: clientId,
        redirect_uri: "https://member.example.com/cb",
        resource: "https://test.example.com/mcp",
        state: "",
        scope: "mcp:read",
        decision: "approve",
      }).toString(),
      redirect: "manual",
    });
    expect(decisionRes.status).toBe(302);
    const redirectLocation = decisionRes.headers.get("location") ?? "";
    const code = new URL(redirectLocation).searchParams.get("code");
    expect(code).not.toBeNull();

    const tokenRes = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        code_verifier: CODE_VERIFIER,
        redirect_uri: "https://member.example.com/cb",
        client_id: clientId,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const { scope } = (await tokenRes.json()) as { scope: string };
    const scopes = scope.split(" ");
    expect(scopes).not.toContain("mcp:admin");
    expect(scopes).toContain("mcp:read");
  });

  test("role downgrade between consent render and decision denies when the baseline is lost", async () => {
    const [user] = await db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "downgrade@test.local",
        role_id: await builtinRoleId(db, "member"),
      })
      .returning();
    if (!user) throw new Error("seed user failed");

    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://downgrade.example.com/cb"] }),
    });
    expect(regRes.status).toBe(201);
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    const sessionId = await seedSession(db, ctx.tenantId, user.id);
    const jwt = await mintSessionCookie({
      session_id: sessionId,
      user_id: user.id,
      tenant_id: ctx.tenantId,
    });

    const authRes = await fetch(
      `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://downgrade.example.com/cb",
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        scope: "mcp:read mcp:authoring",
      })}`,
      { headers: { cookie: `subkit_session=${jwt}` }, redirect: "manual" },
    );
    expect(authRes.status).toBe(200);
    const html = await authRes.text();
    const csrfMatch = html.match(/name="csrf_token"\s+value="([^"]+)"/);
    expect(csrfMatch).not.toBeNull();
    const csrfToken = csrfMatch![1] as string;

    await db
      .update(users)
      .set({ role_id: await builtinRoleId(db, "enduser") })
      .where(eq(users.id, user.id));

    const decisionRes = await fetch(`${ctx.baseUrl}/v1/oauth/authorize/decision`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `subkit_session=${jwt}`,
      },
      body: new URLSearchParams({
        csrf_token: csrfToken,
        client_id: clientId,
        redirect_uri: "https://downgrade.example.com/cb",
        resource: "https://test.example.com/mcp",
        state: "",
        scope: "mcp:read mcp:authoring",
        decision: "approve",
      }).toString(),
      redirect: "manual",
    });
    expect(decisionRes.status).toBe(302);
    const location = new URL(decisionRes.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
  });
});

describe("scope selection — client request is a hard ceiling", () => {
  test("admin requesting only mcp:read cannot display or grant mcp:admin", async () => {
    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://elevate.example.com/cb"] }),
    });
    expect(regRes.status).toBe(201);
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    const sessionId = await seedSession(db, ctx.tenantId, ctx.userId);
    const jwt = await mintSessionCookie({
      session_id: sessionId,
      user_id: ctx.userId,
      tenant_id: ctx.tenantId,
    });

    const authRes = await fetch(
      `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://elevate.example.com/cb",
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        scope: "mcp:read",
      })}`,
      { headers: { cookie: `subkit_session=${jwt}` }, redirect: "manual" },
    );
    expect(authRes.status).toBe(200);
    const html = await authRes.text();
    expect(html).toContain('value="mcp:read"');
    expect(html).not.toContain('value="mcp:authoring"');
    expect(html).not.toContain('value="mcp:admin"');

    const csrfMatch = html.match(/name="csrf_token"\s+value="([^"]+)"/);
    const csrfToken = csrfMatch![1] as string;

    const decisionRes = await fetch(`${ctx.baseUrl}/v1/oauth/authorize/decision`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `subkit_session=${jwt}`,
      },
      body: `csrf_token=${encodeURIComponent(csrfToken)}&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://elevate.example.com/cb")}&resource=${encodeURIComponent("https://test.example.com/mcp")}&state=&decision=approve&scope=mcp%3Aread&scope=mcp%3Aadmin`,
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
        code: code!,
        code_verifier: CODE_VERIFIER,
        redirect_uri: "https://elevate.example.com/cb",
        client_id: clientId,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const { scope } = (await tokenRes.json()) as { scope: string };
    const scopes = scope.split(" ");
    expect(scopes).toContain("mcp:read");
    expect(scopes).not.toContain("mcp:admin");
  });

  test("member tampering with a non-offered mcp:admin scope is clamped away", async () => {
    const [memberUser] = await db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "tamper@test.local",
        role_id: await builtinRoleId(db, "member"),
      })
      .returning();
    if (!memberUser) throw new Error("seed member user failed");

    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://tamper.example.com/cb"] }),
    });
    expect(regRes.status).toBe(201);
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    const sessionId = await seedSession(db, ctx.tenantId, memberUser.id);
    const jwt = await mintSessionCookie({
      session_id: sessionId,
      user_id: memberUser.id,
      tenant_id: ctx.tenantId,
    });

    const authRes = await fetch(
      `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://tamper.example.com/cb",
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        scope: "mcp:read",
      })}`,
      { headers: { cookie: `subkit_session=${jwt}` }, redirect: "manual" },
    );
    const html = await authRes.text();
    const csrfToken = html.match(/name="csrf_token"\s+value="([^"]+)"/)![1] as string;

    const decisionRes = await fetch(`${ctx.baseUrl}/v1/oauth/authorize/decision`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `subkit_session=${jwt}`,
      },
      body: `csrf_token=${encodeURIComponent(csrfToken)}&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://tamper.example.com/cb")}&resource=${encodeURIComponent("https://test.example.com/mcp")}&state=&decision=approve&scope=mcp%3Aread&scope=mcp%3Aadmin`,
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
        code: code!,
        code_verifier: CODE_VERIFIER,
        redirect_uri: "https://tamper.example.com/cb",
        client_id: clientId,
      }).toString(),
    });
    const { scope } = (await tokenRes.json()) as { scope: string };
    expect(scope.split(" ")).not.toContain("mcp:admin");
    expect(scope.split(" ")).toContain("mcp:read");
  });
});

describe("scope intersection — member role requesting only mcp:admin", () => {
  test("/authorize denies instead of substituting unrequested scopes", async () => {
    const [memberUser] = await db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "member-admin-only@test.local",
        role_id: await builtinRoleId(db, "member"),
      })
      .returning();
    if (!memberUser) throw new Error("seed member user failed");

    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://admin-only.example.com/cb"] }),
    });
    expect(regRes.status).toBe(201);
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    const sessionId = await seedSession(db, ctx.tenantId, memberUser.id);
    const jwt = await mintSessionCookie({
      session_id: sessionId,
      user_id: memberUser.id,
      tenant_id: ctx.tenantId,
    });

    const res = await fetch(
      `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://admin-only.example.com/cb",
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        scope: "mcp:admin",
      })}`,
      {
        headers: { cookie: `subkit_session=${jwt}` },
        redirect: "manual",
      },
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
  });
});

async function runFullOAuthFlow(opts: {
  redirectUri: string;
  label: string;
}): Promise<{ access_token: string; refresh_token: string; client_id: string }> {
  const { redirectUri, label } = opts;

  const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: label }),
  });
  expect(regRes.status).toBe(201);
  const { client_id: clientId } = (await regRes.json()) as { client_id: string };

  const sessionId = await seedSession(db, ctx.tenantId, ctx.userId);
  const jwt = await mintSessionCookie({
    session_id: sessionId,
    user_id: ctx.userId,
    tenant_id: ctx.tenantId,
  });

  const authRes = await fetch(
    `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
      scope: "mcp:read",
    })}`,
    { headers: { cookie: `subkit_session=${jwt}` }, redirect: "manual" },
  );
  const html = await authRes.text();
  const csrfMatch = html.match(/name="csrf_token"\s+value="([^"]+)"/);
  if (!csrfMatch) throw new Error("csrf_token not found in consent page");
  const csrfToken = csrfMatch[1] as string;

  const decisionRes = await fetch(`${ctx.baseUrl}/v1/oauth/authorize/decision`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `subkit_session=${jwt}`,
    },
    body: new URLSearchParams({
      csrf_token: csrfToken,
      client_id: clientId,
      redirect_uri: redirectUri,
      resource: "https://test.example.com/mcp",
      state: "",
      scope: "mcp:read",
      decision: "approve",
    }).toString(),
    redirect: "manual",
  });
  const loc = decisionRes.headers.get("location") ?? "";
  const code = new URL(loc).searchParams.get("code");
  if (!code) throw new Error("code not found in redirect");

  const tokenRes = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: CODE_VERIFIER,
      redirect_uri: redirectUri,
      client_id: clientId,
    }).toString(),
  });
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };
  return { ...tokens, client_id: clientId };
}

describe("audit log entries (HTTP layer)", () => {
  test("consent granted writes mcp_oauth.consent_granted audit entry", async () => {
    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://audit.example.com/cb"] }),
    });
    expect(regRes.status).toBe(201);
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    const sessionId = await seedSession(db, ctx.tenantId, ctx.userId);
    const jwt = await mintSessionCookie({
      session_id: sessionId,
      user_id: ctx.userId,
      tenant_id: ctx.tenantId,
    });

    const authRes = await fetch(
      `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://audit.example.com/cb",
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        scope: "mcp:read",
      })}`,
      { headers: { cookie: `subkit_session=${jwt}` }, redirect: "manual" },
    );
    const html = await authRes.text();
    const csrfMatch = html.match(/name="csrf_token"\s+value="([^"]+)"/);
    const csrfToken = csrfMatch![1] as string;

    const decisionRes = await fetch(`${ctx.baseUrl}/v1/oauth/authorize/decision`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `subkit_session=${jwt}`,
      },
      body: new URLSearchParams({
        csrf_token: csrfToken,
        client_id: clientId,
        redirect_uri: "https://audit.example.com/cb",
        resource: "https://test.example.com/mcp",
        state: "",
        scope: "mcp:read",
        decision: "approve",
      }).toString(),
      redirect: "manual",
    });
    expect(decisionRes.status).toBe(302);

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "mcp_oauth.consent_granted"), eq(auditLog.tenant_id, ctx.tenantId)),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe("audit log entries — token lifecycle (HTTP layer)", () => {
  test("mcp_oauth.token_issued row exists after full code exchange", async () => {
    await runFullOAuthFlow({
      redirectUri: "https://audit-issued.example.com/cb",
      label: "AuditIssued",
    });

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "mcp_oauth.token_issued"), eq(auditLog.tenant_id, ctx.tenantId)),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("mcp_oauth.token_refreshed row exists after a refresh cycle", async () => {
    const { refresh_token, client_id: clientId } = await runFullOAuthFlow({
      redirectUri: "https://audit-refreshed.example.com/cb",
      label: "AuditRefreshed",
    });

    const refreshRes = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token,
        client_id: clientId,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "mcp_oauth.token_refreshed"), eq(auditLog.tenant_id, ctx.tenantId)),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("mcp_oauth.token_revoked row exists after /v1/oauth/revoke with real token", async () => {
    const { access_token } = await runFullOAuthFlow({
      redirectUri: "https://audit-revoked.example.com/cb",
      label: "AuditRevoked",
    });

    const revokeRes = await fetch(`${ctx.baseUrl}/v1/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: access_token }).toString(),
    });
    expect(revokeRes.status).toBe(200);

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "mcp_oauth.token_revoked"), eq(auditLog.tenant_id, ctx.tenantId)),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("revoking a refresh token rejects its associated access token at /mcp", async () => {
    const { access_token, refresh_token } = await runFullOAuthFlow({
      redirectUri: "https://refresh-family-revoked.example.com/cb",
      label: "RefreshFamilyRevoked",
    });

    const revokeRes = await fetch(`${ctx.baseUrl}/v1/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh_token }).toString(),
    });
    expect(revokeRes.status).toBe(200);

    const mcpRes = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(mcpRes.status).toBe(401);
  });
});

function browserSubmittedScopes(html: string): string[] {
  const form = html.match(/<form\b[^>]*>([\s\S]*?)<\/form>/i)?.[1] ?? "";
  const scopes: string[] = [];
  for (const tag of form.match(/<input\b[^>]*name="scope"[^>]*>/gi) ?? []) {
    const value = tag.match(/value="([^"]*)"/)?.[1];
    if (!value) continue;
    const isHidden = /type="hidden"/i.test(tag);
    const isCheckbox = /type="checkbox"/i.test(tag);
    const checked = /\bchecked\b/i.test(tag);
    const disabled = /\bdisabled\b/i.test(tag);
    if (isHidden || (isCheckbox && checked && !disabled)) scopes.push(value);
  }
  return scopes;
}

describe("consent form structure — scope inputs must submit", () => {
  test("a member approving the rendered form is granted (not denied as role_downgrade)", async () => {
    const [memberUser] = await db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "form-structure@test.local",
        role_id: await builtinRoleId(db, "member"),
      })
      .returning();
    if (!memberUser) throw new Error("seed member user failed");

    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://form.example.com/cb"] }),
    });
    expect(regRes.status).toBe(201);
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    const sessionId = await seedSession(db, ctx.tenantId, memberUser.id);
    const jwt = await mintSessionCookie({
      session_id: sessionId,
      user_id: memberUser.id,
      tenant_id: ctx.tenantId,
    });

    const authRes = await fetch(
      `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://form.example.com/cb",
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        scope: "mcp:read",
      })}`,
      { headers: { cookie: `subkit_session=${jwt}` }, redirect: "manual" },
    );
    expect(authRes.status).toBe(200);
    const html = await authRes.text();

    const submitted = browserSubmittedScopes(html);
    expect(submitted).toContain("mcp:read");

    const csrfToken = html.match(/name="csrf_token"\s+value="([^"]+)"/)![1] as string;

    const body = new URLSearchParams();
    body.set("csrf_token", csrfToken);
    body.set("client_id", clientId);
    body.set("redirect_uri", "https://form.example.com/cb");
    body.set("resource", "https://test.example.com/mcp");
    body.set("state", "");
    body.set("decision", "approve");
    for (const s of submitted) body.append("scope", s);

    const decisionRes = await fetch(`${ctx.baseUrl}/v1/oauth/authorize/decision`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `subkit_session=${jwt}`,
      },
      body: body.toString(),
      redirect: "manual",
    });
    expect(decisionRes.status).toBe(302);
    const location = new URL(decisionRes.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBeNull();
    expect(location.searchParams.get("code")).not.toBeNull();
  });
});
