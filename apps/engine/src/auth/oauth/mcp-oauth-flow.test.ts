// Integration tests for MCP OAuth HTTP routes — mcp-oauth-flow group.
// Shared setup + helpers live in ./mcp-oauth-test-helpers.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "../../db/client.ts";
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
  const s = await setupMcpOauthServer("mcp-oauth-flow");
  ctx = s.ctx;
  db = ctx.db;
  priorBaseUrl = s.priorBaseUrl;
}, 30_000);

afterAll(async () => {
  await teardownMcpOauthServer(ctx, priorBaseUrl);
}, 30_000);

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
        scope: "mcp:read",
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
        scope: "mcp:read",
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
