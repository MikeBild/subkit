// Integration tests for MCP OAuth HTTP routes — mcp-oauth-scope-audit group.
// Shared setup + helpers live in ./mcp-oauth-test-helpers.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { auditLog, sessions, users } from "../../db/schema/index.ts";
import type { HttpTestServer } from "../../http/tests/setup.ts";
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

beforeAll(async () => {
  const s = await setupMcpOauthServer("mcp-oauth-scope-audit");
  ctx = s.ctx;
  db = ctx.db;
  priorBaseUrl = s.priorBaseUrl;
}, 30_000);

afterAll(async () => {
  await teardownMcpOauthServer(ctx, priorBaseUrl);
}, 30_000);

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

// ─── Consent denial ────────────────────────────────────────────────────────

describe("consent denial", () => {
  test("deny redirects to redirect_uri with error=access_denied", async () => {
    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example.com/deny-cb"] }),
    });
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
        resource: "",
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

    // Revoke the session row AFTER the consent page rendered.
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
        resource: "",
        state: "",
        decision: "approve",
      }).toString(),
      redirect: "manual",
    });
    expect(decisionRes.status).toBe(401);
  });
});

// ─── Scope intersection: member role cannot get mcp:admin ─────────────────

describe("scope intersection — role-based scope restriction", () => {
  test("member role requesting mcp:admin receives token without mcp:admin", async () => {
    // Seed a member-role user
    const [memberUser] = await db
      .insert(users)
      .values({ tenant_id: ctx.tenantId, email: "member-scope@test.local", role: "member" })
      .returning();
    if (!memberUser) throw new Error("seed member user failed");

    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://member.example.com/cb"] }),
    });
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
        // Request mcp:admin — should be stripped for a member
        scope: "mcp:read mcp:admin",
      })}`,
      { headers: { cookie: `subkit_session=${jwt}` }, redirect: "manual" },
    );
    // Consent page loads (200)
    expect(authRes.status).toBe(200);
    const html = await authRes.text();
    // The consent page should NOT show mcp:admin for a member role
    // (it is intersected away). mcp:admin should be absent from the scope list.
    expect(html).not.toContain(">mcp:admin<");

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
        resource: "",
        state: "",
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

  test("role downgrade between consent render and decision denies the grant", async () => {
    // Member renders the consent page for mcp:authoring (a scope an
    // enduser does NOT hold), is then downgraded to enduser, and clicks
    // Approve. The decision handler re-intersects against the fresh role;
    // the empty result must deny — no code, no token at the stale scope.
    const [user] = await db
      .insert(users)
      .values({ tenant_id: ctx.tenantId, email: "downgrade@test.local", role: "member" })
      .returning();
    if (!user) throw new Error("seed user failed");

    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://downgrade.example.com/cb"] }),
    });
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
        scope: "mcp:authoring",
      })}`,
      { headers: { cookie: `subkit_session=${jwt}` }, redirect: "manual" },
    );
    expect(authRes.status).toBe(200);
    const html = await authRes.text();
    const csrfMatch = html.match(/name="csrf_token"\s+value="([^"]+)"/);
    expect(csrfMatch).not.toBeNull();
    const csrfToken = csrfMatch![1] as string;

    // Downgrade AFTER the consent page rendered, BEFORE the decision POST.
    await db.update(users).set({ role: "enduser" }).where(eq(users.id, user.id));

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
        resource: "",
        state: "",
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

// ─── Audit log assertions ──────────────────────────────────────────────────
// The HTTP layer uses the same db connection that the test DB uses (via
// createHttpTestServer). Audit writes go to the test DB here.

describe("scope intersection — member role requesting only mcp:admin", () => {
  test("/authorize 302-redirects with error=access_denied when scope=mcp:admin and role=member", async () => {
    // Seed a member-role user
    const [memberUser] = await db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "member-admin-only@test.local",
        role: "member",
      })
      .returning();
    if (!memberUser) throw new Error("seed member user failed");

    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://admin-only.example.com/cb"] }),
    });
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    const sessionId = await seedSession(db, ctx.tenantId, memberUser.id);
    const jwt = await mintSessionCookie({
      session_id: sessionId,
      user_id: memberUser.id,
      tenant_id: ctx.tenantId,
    });

    // Request ONLY mcp:admin — member role has no mcp:admin → empty intersection
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
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("error=access_denied");
  });
});

// ── Audit entries: token_issued, token_refreshed, token_revoked ───────────────

// Full-flow helper used by the audit tests below
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
      resource: "",
      state: "",
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
        resource: "",
        state: "",
        decision: "approve",
      }).toString(),
      redirect: "manual",
    });
    expect(decisionRes.status).toBe(302);

    // consent_granted is written via auditAwait before the 302 response.
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "mcp_oauth.consent_granted"), eq(auditLog.tenant_id, ctx.tenantId)),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ── AS metadata: token_endpoint_auth_methods_supported ────────────────────────

describe("audit log entries — token lifecycle (HTTP layer)", () => {
  test("mcp_oauth.token_issued row exists after full code exchange", async () => {
    await runFullOAuthFlow({
      redirectUri: "https://audit-issued.example.com/cb",
      label: "AuditIssued",
    });

    // token_issued is written via auditAwait before the token response.
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

    // token_refreshed is written via auditAwait before the token response.
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

    // token_revoked is written via auditAwait before the 200 response.
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "mcp_oauth.token_revoked"), eq(auditLog.tenant_id, ctx.tenantId)),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
