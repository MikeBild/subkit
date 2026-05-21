// Integration tests for MCP OAuth HTTP routes.
// Uses the full Hono app stack via createHttpTestServer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { getConfig, setConfigKey } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { auditLog, sessions, users } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";

let ctx: HttpTestServer;
let db: Db;

// Mirrors oauth.ts deriveSessionSecret() exactly: prefer the configured
// auth.session.secret (loadConfig auto-generates one on first boot), and
// fall back to the MASTER_KEY-derived value only when no config secret
// exists. A test cookie must be signed with whatever secret the handler
// will verify with, or session resolution fails.
function deriveTestSessionSecret(): Uint8Array {
  try {
    const fromConfig = (getConfig().auth.session.secret ?? "").trim();
    if (fromConfig.length > 0) return new TextEncoder().encode(fromConfig);
  } catch {
    /* loader not initialised */
  }
  const masterKey = process.env.MASTER_KEY ?? "";
  return new Uint8Array(createHash("sha256").update(`${masterKey}:session`).digest());
}

async function mintSessionCookie(payload: {
  session_id: string;
  user_id: string;
  tenant_id: string;
}): Promise<string> {
  const secret = deriveTestSessionSecret();
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
}

async function seedSession(dbArg: Db, tenantId: string, userId: string): Promise<string> {
  const [row] = await dbArg
    .insert(sessions)
    .values({
      tenant_id: tenantId,
      user_id: userId,
      expires_at: new Date(Date.now() + 3_600_000), // allow-wall-clock
      last_seen_at: new Date(), // allow-wall-clock
      absolute_expires_at: new Date(Date.now() + 86_400_000), // allow-wall-clock
    })
    .returning();
  if (!row) throw new Error("seed session failed");
  return row.id;
}

function makeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = makeChallenge(CODE_VERIFIER);

// The OAuth discovery documents, the login-redirect funnel, and the
// /mcp WWW-Authenticate resource_metadata header all resolve against
// server.public_base_url. Set it explicitly so the suite is
// self-contained and does not depend on an external SK_OVERRIDE_* env.
let priorBaseUrl = "";

beforeAll(async () => {
  ctx = await createHttpTestServer("mcp-oauth-routes");
  db = ctx.db;
  priorBaseUrl = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", "https://test.example.com", { force: true });
}, 30_000);

afterAll(async () => {
  await setConfigKey("server.public_base_url", priorBaseUrl, { force: true });
  await ctx.cleanup();
}, 30_000);

// ─── .well-known endpoints ─────────────────────────────────────────────────

describe("GET /.well-known/oauth-protected-resource", () => {
  test("returns 200 with RFC 9728 shaped document", async () => {
    const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.resource).toBe("string");
    expect(Array.isArray(body.authorization_servers)).toBe(true);
    expect((body.authorization_servers as string[]).length).toBeGreaterThan(0);
  });

  test("/mcp variant also returns RFC 9728 document", async () => {
    const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.resource).toBe("string");
    expect(Array.isArray(body.authorization_servers)).toBe(true);
  });
});

describe("GET /.well-known/oauth-authorization-server", () => {
  test("returns 200 with RFC 8414 shaped document", async () => {
    const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.issuer).toBe("string");
    expect(typeof body.authorization_endpoint).toBe("string");
    expect(typeof body.token_endpoint).toBe("string");
    expect(typeof body.registration_endpoint).toBe("string");
    expect(typeof body.revocation_endpoint).toBe("string");
    expect(Array.isArray(body.response_types_supported)).toBe(true);
    expect(Array.isArray(body.grant_types_supported)).toBe(true);
    expect(Array.isArray(body.code_challenge_methods_supported)).toBe(true);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
  });

  test("scopes_supported is present and non-empty", async () => {
    const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`);
    const body = (await res.json()) as { scopes_supported?: string[] };
    expect(Array.isArray(body.scopes_supported)).toBe(true);
    expect((body.scopes_supported ?? []).length).toBeGreaterThan(0);
  });
});

// ─── POST /v1/oauth/register (DCR) ─────────────────────────────────────────

describe("POST /v1/oauth/register", () => {
  test("registers client and returns 201 with required fields", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://myapp.example.com/callback"],
        client_name: "My Test App",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.client_id).toBe("string");
    expect(typeof body.client_id_issued_at).toBe("number");
    expect(Array.isArray(body.redirect_uris)).toBe(true);
    // registration_client_uri is intentionally not advertised — subkit
    // does not serve the RFC 7591 client-configuration endpoint.
    expect(body.registration_client_uri).toBeUndefined();
  });

  test("returns 400 with invalid_client_metadata for missing redirect_uris", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "NoRedirectUri" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client_metadata");
  });

  test("returns 400 for non-URL redirect_uri", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["not-a-url"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client_metadata");
  });

  test("returns 400 for invalid JSON body", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json at all",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client_metadata");
  });
});

// ─── GET /v1/oauth/authorize ────────────────────────────────────────────────

describe("GET /v1/oauth/authorize", () => {
  async function registerClient(): Promise<string> {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example.com/cb"],
        client_name: "Authorize Test Client",
      }),
    });
    const body = (await res.json()) as { client_id: string };
    return body.client_id;
  }

  function authorizeUrl(params: Record<string, string>): string {
    const qs = new URLSearchParams(params).toString();
    return `${ctx.baseUrl}/v1/oauth/authorize?${qs}`;
  }

  test("missing client_id returns 400", async () => {
    const res = await fetch(
      authorizeUrl({
        redirect_uri: "https://client.example.com/cb",
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("missing redirect_uri returns 400", async () => {
    const clientId = await registerClient();
    const res = await fetch(
      authorizeUrl({
        client_id: clientId,
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("unknown client_id returns 400", async () => {
    const res = await fetch(
      authorizeUrl({
        client_id: "nonexistentclientid1234",
        redirect_uri: "https://client.example.com/cb",
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
  });

  test("unregistered redirect_uri returns 400 (open-redirect guard)", async () => {
    const clientId = await registerClient();
    const res = await fetch(
      authorizeUrl({
        client_id: clientId,
        redirect_uri: "https://attacker.example.com/steal",
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  test("no session cookie redirects to login page", async () => {
    const clientId = await registerClient();
    const res = await fetch(
      authorizeUrl({
        client_id: clientId,
        redirect_uri: "https://client.example.com/cb",
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        scope: "mcp:read",
      }),
      { redirect: "manual" },
    );
    // Must redirect — not return the consent page
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("login");
  });

  test("non-S256 code_challenge_method redirects with error=invalid_request", async () => {
    const clientId = await registerClient();
    const res = await fetch(
      authorizeUrl({
        client_id: clientId,
        redirect_uri: "https://client.example.com/cb",
        response_type: "code",
        code_challenge: "plain-challenge-value",
        code_challenge_method: "plain",
        scope: "mcp:read",
      }),
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("error=invalid_request");
  });

  test("with valid session shows consent page (200 HTML)", async () => {
    const clientId = await registerClient();
    const sessionId = await seedSession(db, ctx.tenantId, ctx.userId);
    const jwt = await mintSessionCookie({
      session_id: sessionId,
      user_id: ctx.userId,
      tenant_id: ctx.tenantId,
    });

    const res = await fetch(
      authorizeUrl({
        client_id: clientId,
        redirect_uri: "https://client.example.com/cb",
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        scope: "mcp:read",
      }),
      {
        headers: { cookie: `subkit_session=${jwt}` },
        redirect: "manual",
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Authorize access");
  });
});

// ─── Full flow: register → authorize → consent → token → /mcp ─────────────

describe("full OAuth flow", () => {
  test("register → authorize (consent) → code → access token", async () => {
    // 1. Register a client
    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example.com/flow-cb"],
        client_name: "Flow Test",
      }),
    });
    expect(regRes.status).toBe(201);
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    // 2. Seed a session and get the consent page
    const sessionId = await seedSession(db, ctx.tenantId, ctx.userId);
    const jwt = await mintSessionCookie({
      session_id: sessionId,
      user_id: ctx.userId,
      tenant_id: ctx.tenantId,
    });

    const authRes = await fetch(
      `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://client.example.com/flow-cb",
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        scope: "mcp:read",
        state: "test-state-123",
      })}`,
      {
        headers: { cookie: `subkit_session=${jwt}` },
        redirect: "manual",
      },
    );
    expect(authRes.status).toBe(200);
    const html = await authRes.text();

    // Extract csrf_token from the form
    const csrfMatch = html.match(/name="csrf_token"\s+value="([^"]+)"/);
    expect(csrfMatch).not.toBeNull();
    const csrfToken = csrfMatch![1] as string;

    // 3. Submit the consent decision
    const decisionRes = await fetch(`${ctx.baseUrl}/v1/oauth/authorize/decision`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `subkit_session=${jwt}`,
      },
      body: new URLSearchParams({
        csrf_token: csrfToken,
        client_id: clientId,
        redirect_uri: "https://client.example.com/flow-cb",
        resource: "",
        state: "test-state-123",
        decision: "approve",
      }).toString(),
      redirect: "manual",
    });
    expect(decisionRes.status).toBe(302);
    const redirectLocation = decisionRes.headers.get("location") ?? "";
    expect(redirectLocation).toContain("code=");
    expect(redirectLocation).toContain("state=test-state-123");

    // 4. Extract the code
    const redirectUrl = new URL(redirectLocation);
    const code = redirectUrl.searchParams.get("code");
    expect(code).not.toBeNull();

    // 5. Exchange the code for tokens
    const tokenRes = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        code_verifier: CODE_VERIFIER,
        redirect_uri: "https://client.example.com/flow-cb",
        client_id: clientId,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(tokens.access_token).toMatch(/^wf_mcp_/);
    expect(tokens.refresh_token).toMatch(/^wf_mcr_/);
    expect(tokens.token_type).toBe("bearer");
    expect(tokens.scope).toBe("mcp:read");
  });

  test("refresh token grant produces new tokens via POST /v1/oauth/token", async () => {
    // Register + get initial tokens
    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example.com/refresh-cb"],
        client_name: "Refresh Test",
      }),
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
        redirect_uri: "https://client.example.com/refresh-cb",
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
        redirect_uri: "https://client.example.com/refresh-cb",
        resource: "",
        state: "",
        decision: "approve",
      }).toString(),
      redirect: "manual",
    });
    const redirectLocation = decisionRes.headers.get("location") ?? "";
    const code = new URL(redirectLocation).searchParams.get("code");

    const tokenRes = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        code_verifier: CODE_VERIFIER,
        redirect_uri: "https://client.example.com/refresh-cb",
        client_id: clientId,
      }).toString(),
    });
    const { refresh_token } = (await tokenRes.json()) as { refresh_token: string };

    // Now use the refresh token
    const refreshRes = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh_token,
        client_id: clientId,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(refreshed.access_token).toMatch(/^wf_mcp_/);
    expect(refreshed.refresh_token).toMatch(/^wf_mcr_/);
    expect(refreshed.access_token).not.toBe(refresh_token);
  });
});

// ─── POST /v1/oauth/token — edge cases ────────────────────────────────────

describe("POST /v1/oauth/token — edge cases", () => {
  test("missing required params returns 400", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  test("unsupported grant_type returns 400", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=implicit",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unsupported_grant_type");
  });

  test("invalid authorization code returns 400 invalid_grant", async () => {
    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://app.example.com/cb"] }),
    });
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    const res = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "invalid-code-value",
        code_verifier: CODE_VERIFIER,
        redirect_uri: "https://app.example.com/cb",
        client_id: clientId,
      }).toString(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });
});

// ─── POST /v1/oauth/revoke ─────────────────────────────────────────────────

describe("POST /v1/oauth/revoke", () => {
  test("always returns 200 for unknown token (RFC 7009)", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=wf_mcp_completelyunknowntoken123456789",
    });
    expect(res.status).toBe(200);
  });

  test("missing token parameter returns 400", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(res.status).toBe(400);
  });
});

// ─── Unauthenticated /mcp returns 401 + WWW-Authenticate ──────────────────

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

describe("AS metadata: token_endpoint_auth_methods_supported", () => {
  test("contains 'none' and does NOT contain client_secret_basic or client_secret_post", async () => {
    const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token_endpoint_auth_methods_supported?: string[] };
    const methods = body.token_endpoint_auth_methods_supported ?? [];
    expect(methods).toContain("none");
    expect(methods).not.toContain("client_secret_basic");
    expect(methods).not.toContain("client_secret_post");
  });
});

// ── DCR redirect_uri validation ────────────────────────────────────────────────

describe("POST /v1/oauth/register — redirect_uri validation", () => {
  test("rejects http:// to public host with 400 invalid_client_metadata", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client_metadata");
  });

  test("rejects javascript:/data:/file: pseudo-scheme redirect URIs", async () => {
    for (const uri of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
      const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [uri] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_client_metadata");
    }
  });

  test("allows http://localhost:3000/cb and returns 201", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:3000/cb"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string };
    expect(typeof body.client_id).toBe("string");
  });

  test("rejects more than 5 redirect_uris with 400 invalid_client_metadata", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [
          "https://app.example.com/cb1",
          "https://app.example.com/cb2",
          "https://app.example.com/cb3",
          "https://app.example.com/cb4",
          "https://app.example.com/cb5",
          "https://app.example.com/cb6",
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client_metadata");
  });

  test("rejects token_endpoint_auth_method=client_secret_basic with 400 invalid_client_metadata", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://myapp.example.com/cb"],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client_metadata");
  });
});

// ── DCR per-IP rate limit ──────────────────────────────────────────────────────

describe("POST /v1/oauth/register — per-IP rate limit", () => {
  test("11th registration from same IP returns 429", async () => {
    // Use a unique IP that isn't used anywhere else in this file to avoid
    // collisions with the module-level dcrBuckets map.
    const uniqueIp = "10.9.8.7";
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": uniqueIp,
        },
        body: JSON.stringify({ redirect_uris: [`https://ratelimit-test.example.com/cb${i}`] }),
      });
      lastStatus = res.status;
      // drain body
      await res.json().catch(() => null);
    }
    expect(lastStatus).toBe(429);
  });
});

// ── /token: 64KB form body limit ──────────────────────────────────────────────

describe("POST /v1/oauth/token — body size limit", () => {
  test("form body over 64KB returns 413", async () => {
    const padding = "x".repeat(65 * 1024);
    const body = `grant_type=authorization_code&code=${padding}`;
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(res.status).toBe(413);
  });
});

// ── /token: JSON body with bad code returns invalid_grant ─────────────────────

describe("POST /v1/oauth/token — JSON body", () => {
  test("valid-shape JSON body with bad code returns 400 invalid_grant", async () => {
    // Register a client so client_id exists
    const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://json-token.example.com/cb"] }),
    });
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    const res = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: "definitely-not-a-real-code-value",
        code_verifier: CODE_VERIFIER,
        redirect_uri: "https://json-token.example.com/cb",
        client_id: clientId,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });
});

// ── /mcp: wf_mcr_* refresh token as Bearer → 401 ─────────────────────────────

describe("POST /mcp — refresh token as Bearer", () => {
  test("wf_mcr_* refresh token sent as Authorization: Bearer returns 401", async () => {
    // A refresh token prefix should be rejected by the mcp-oauth auth provider
    // (extractMcpToken only accepts wf_mcp_ prefix) → 401
    const fakeRefreshToken = "wf_mcr_abcdefghijklmnopqrstuvwxyz01234567";
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fakeRefreshToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(401);
  });
});

// ── Scope intersection: member-only mcp:admin → access_denied ─────────────────

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
