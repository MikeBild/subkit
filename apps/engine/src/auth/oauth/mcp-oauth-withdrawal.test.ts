// Tranche E — a connection belongs to the installation, and a withdrawn
// person loses it.
//
// Every test here drives the REAL consent funnel over HTTP: register a
// client, render the consent page, submit the decision, exchange the code.
// What follows is the part that used to be untested:
//
//   rule 1  signing out of the Cockpit must NOT end the connection
//   rule 2  withdrawing the person MUST end it, on its next use
//   rule 3  refresh is checked exactly like access — asserted as pairs
//   rule 5  a rotation and a fresh resolver ("restart") change nothing
//
// SubKit keeps no in-process authentication state across a restart except
// the `last_used_at` flush throttle, so the honest restart proxy is a fresh
// `createMcpOAuthAuthProvider({ resetThrottle: true })` resolving the same
// token — noted here so the assertion is not read as more than it is.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { mcpOauthClients, users } from "../../db/schema/index.ts";
import type { HttpTestServer } from "../../http/tests/setup.ts";
import { countLiveConnectionsByUser } from "../../identity/oauth-connections.ts";
import { deactivateUser } from "../../identity/provisioning.ts";
import { signBrowserCsrf } from "../browser-session.ts";
import { createMcpOAuthAuthProvider } from "../providers/mcp-oauth.ts";
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
  const s = await setupMcpOauthServer("mcp-oauth-withdrawal");
  ctx = s.ctx;
  db = ctx.db;
  priorBaseUrl = s.priorBaseUrl;
}, 30_000);

afterAll(async () => {
  await teardownMcpOauthServer(ctx, priorBaseUrl);
}, 30_000);

interface TokenPair {
  access_token: string;
  refresh_token: string;
}

interface Connection extends TokenPair {
  clientId: string;
  jwt: string;
  sessionId: string;
  userId: string;
}

// The resource server the tokens must name (RFC 8707). The suite pins
// `server.public_base_url` to this host, so a token minted without it is
// rejected as `audience_missing` before any liveness check is reached.
const RESOURCE = "https://test.example.com/mcp";

let seq = 0;

/** A person the tests may withdraw without disturbing the shared fixture user. */
async function seedPerson(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: `withdrawal-${++seq}@test.local`,
      role: "admin",
    })
    .returning({ id: users.id });
  if (!row) throw new Error("seed user failed");
  return row.id;
}

/** Register a client and walk the whole consent funnel as `userId`. */
async function approveConnection(userId?: string): Promise<Connection> {
  const person = userId ?? (await seedPerson());
  const redirectUri = `https://client.example.com/withdrawal-${++seq}`;

  const regRes = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Withdrawal Test" }),
  });
  expect(regRes.status).toBe(201);
  const { client_id: clientId } = (await regRes.json()) as { client_id: string };

  const sessionId = await seedSession(db, ctx.tenantId, person);
  const jwt = await mintSessionCookie({
    session_id: sessionId,
    user_id: person,
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
      resource: RESOURCE,
    })}`,
    { headers: { cookie: `subkit_session=${jwt}` }, redirect: "manual" },
  );
  expect(authRes.status).toBe(200);
  const html = await authRes.text();
  const csrfToken = html.match(/name="csrf_token"\s+value="([^"]+)"/)?.[1];
  expect(csrfToken).toBeDefined();

  const decisionRes = await fetch(`${ctx.baseUrl}/v1/oauth/authorize/decision`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `subkit_session=${jwt}`,
    },
    body: new URLSearchParams({
      csrf_token: csrfToken as string,
      client_id: clientId,
      redirect_uri: redirectUri,
      resource: RESOURCE,
      state: "",
      scope: "mcp:read",
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
      code: code as string,
      code_verifier: CODE_VERIFIER,
      redirect_uri: redirectUri,
      client_id: clientId,
    }).toString(),
  });
  expect(tokenRes.status).toBe(200);
  const tokens = (await tokenRes.json()) as TokenPair;

  return { ...tokens, clientId, jwt, sessionId, userId: person };
}

/** Use the connection: a protected call on the resource server. */
function callMcp(accessToken: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
  });
}

function refresh(refreshToken: string, clientId: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString(),
  });
}

function withdraw(userId: string): Promise<unknown> {
  return deactivateUser({ tenant_id: ctx.tenantId, user_id: userId, actor_id: null }, db);
}

// ── rule 1 ───────────────────────────────────────────────────────────────────

describe("rule 1 — a connection outlives a browser session", () => {
  test("signing out of the Cockpit leaves the access token and the refresh grant working", async () => {
    const conn = await approveConnection();

    // The Cockpit's own sign-out: session cookie plus the CSRF header the
    // browser sends with every mutating call.
    const csrf = await signBrowserCsrf({
      session_id: conn.sessionId,
      user_id: conn.userId,
      tenant_id: ctx.tenantId,
    });
    const logoutRes = await fetch(`${ctx.baseUrl}/v1/identity/logout`, {
      method: "POST",
      headers: { cookie: `subkit_session=${conn.jwt}`, "x-subkit-csrf": csrf },
    });
    expect(logoutRes.status).toBe(204);

    expect((await callMcp(conn.access_token)).status).not.toBe(401);

    const refreshed = await refresh(conn.refresh_token, conn.clientId);
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as TokenPair;
    expect((await callMcp(next.access_token)).status).not.toBe(401);
  });
});

// ── rule 2 ───────────────────────────────────────────────────────────────────

describe("rule 2 — withdrawing the person ends their connections at once", () => {
  test("the access token is refused on its next use", async () => {
    const conn = await approveConnection();
    expect((await callMcp(conn.access_token)).status).not.toBe(401);

    await withdraw(conn.userId);

    expect((await callMcp(conn.access_token)).status).toBe(401);
  });

  test("the refusal names the withdrawal instead of advising an API key", async () => {
    const conn = await approveConnection();
    await withdraw(conn.userId);

    const res = await refresh(conn.refresh_token, conn.clientId);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description?: string };
    expect(body.error).toBe("invalid_grant");
    const description = (body.error_description ?? "").toLowerCase();
    expect(description.length).toBeGreaterThan(0);
    expect(description).toContain("no longer active");
    expect(description).not.toContain("api key");
  });
});

// ── rule 3 ───────────────────────────────────────────────────────────────────

describe("rule 3 — refresh is checked exactly like access", () => {
  test("a withdrawn person is refused on both paths (pair)", async () => {
    const conn = await approveConnection();
    await withdraw(conn.userId);

    expect((await callMcp(conn.access_token)).status).toBe(401);
    expect((await refresh(conn.refresh_token, conn.clientId)).status).toBe(400);
  });

  test("a merely disabled person — not deleted — is refused on both paths (pair)", async () => {
    const conn = await approveConnection();
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, conn.userId));

    expect((await callMcp(conn.access_token)).status).toBe(401);
    expect((await refresh(conn.refresh_token, conn.clientId)).status).toBe(400);
  });

  test("a revoked client registration is refused on both paths (pair)", async () => {
    const conn = await approveConnection();
    await db
      .update(mcpOauthClients)
      .set({ disabled_at: new Date() }) // allow-wall-clock
      .where(eq(mcpOauthClients.client_id, conn.clientId));

    expect((await callMcp(conn.access_token)).status).toBe(401);
    expect((await refresh(conn.refresh_token, conn.clientId)).status).toBe(400);
  });

  test("a refresh never answers 200 with a credential the access path refuses", async () => {
    const conn = await approveConnection();
    await withdraw(conn.userId);

    const res = await refresh(conn.refresh_token, conn.clientId);
    expect(res.status).not.toBe(200);
  });
});

// ── rule 5 ───────────────────────────────────────────────────────────────────

describe("rule 5 — a restart, a rotation and a closed browser change nothing", () => {
  test("a fresh resolver — the product restarted — still accepts the token", async () => {
    const conn = await approveConnection();
    const provider = createMcpOAuthAuthProvider({ db, resetThrottle: true });
    const principal = await provider.resolve(
      new Request(`${ctx.baseUrl}/mcp`, {
        headers: { authorization: `Bearer ${conn.access_token}` },
      }),
    );
    expect(principal).not.toBeNull();
    expect(principal?.id).toBe(conn.userId);
  });

  test("a rotated pair keeps working, and rotates again", async () => {
    const conn = await approveConnection();

    const first = await refresh(conn.refresh_token, conn.clientId);
    expect(first.status).toBe(200);
    const a = (await first.json()) as TokenPair;
    expect((await callMcp(a.access_token)).status).not.toBe(401);

    const second = await refresh(a.refresh_token, conn.clientId);
    expect(second.status).toBe(200);
    const b = (await second.json()) as TokenPair;
    expect(b.access_token).not.toBe(a.access_token);
    expect((await callMcp(b.access_token)).status).not.toBe(401);
  });
});

// ── rule 4 ───────────────────────────────────────────────────────────────────

describe("rule 4 — the number the Cockpit shows before it asks is the true one", () => {
  test("two approvals by one person count as two connections, and withdrawal leaves none", async () => {
    const first = await approveConnection();
    // A second client, approved by the same person.
    await approveConnection(first.userId);

    const before = await countLiveConnectionsByUser(db, ctx.tenantId, new Date()); // allow-wall-clock
    expect(before.get(first.userId)).toBe(2);

    await withdraw(first.userId);

    const after = await countLiveConnectionsByUser(db, ctx.tenantId, new Date()); // allow-wall-clock
    expect(after.get(first.userId) ?? 0).toBe(0);
  });

  test("a rotation does not inflate the count — one connection stays one", async () => {
    const conn = await approveConnection();
    const rotated = await refresh(conn.refresh_token, conn.clientId);
    expect(rotated.status).toBe(200);

    const counts = await countLiveConnectionsByUser(db, ctx.tenantId, new Date()); // allow-wall-clock
    expect(counts.get(conn.userId)).toBe(1);
  });
});
