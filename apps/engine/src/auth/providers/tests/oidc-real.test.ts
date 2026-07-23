// Pass 2 A1 — real OIDC provider end-to-end coverage.
//
// This suite exercises the full `createOidcProvider()` surface against
// a mock OpenID Connect provider spun up on a random loopback port. It
// is the first test that proves the engine's OIDC path past the old
// `return null` stub: session rows land in Postgres, cookies sign and
// verify, sliding + absolute TTLs enforce, and logout flips the row.
//
// The round trip is staged manually so the test doesn't depend on a
// full browser redirect:
//
//   1. Issue a tenant + seed.
//   2. Have the fixture stage claims for the next `/token` hop.
//   3. Call `provider.finishLogin(req)` with a synthetic callback URL
//      that carries the fixture's `code` and the provider's `state`.
//   4. Read the `Set-Cookie` header and build a follow-up request.
//
// The provider sits on a disposable test database so every assertion
// looks at concrete rows (`sessions`, `audit_log`) without racing the
// rest of the suite.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  oidcLoginStates,
  sessions,
  tenants,
  userIdentities,
  users,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { createOidcProvider } from "../oidc.ts";
import { type MockOidcHandle, startMockOidc } from "./fixtures/mock-oidc.ts";

const TEST_NOW_MS = getTestNow();

let testDb: TestDb;
let mock: MockOidcHandle;
let tenantId = "";
const CLIENT_ID = "mock-client";
const REDIRECT_URI = "http://127.0.0.1:0/v1/identity/login/callback";

beforeAll(async () => {
  testDb = await createTestDb("oidc-real");
  mock = await startMockOidc();

  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "oidc-real", display_name: "OIDC Real" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenantId = t.id;
});

afterAll(async () => {
  try {
    await mock.stop();
  } catch {
    /* ignore */
  }
  if (testDb) await testDb.cleanup();
});

function buildProvider(overrides: { enableSignup?: boolean } = {}) {
  return createOidcProvider({
    db: testDb.db,
    issuerUrl: mock.url,
    clientId: CLIENT_ID,
    clientSecret: "mock-secret",
    redirectUri: REDIRECT_URI,
    // Most cases exercise the JIT path; the signup-gate suite below
    // covers the production default (false) explicitly.
    enableSignup: overrides.enableSignup ?? true,
  });
}

function parseSetCookie(header: string | null): string | null {
  if (!header) return null;
  const head = header.split(";")[0];
  const eq = head?.indexOf("=") ?? -1;
  if (!head || eq < 0) return null;
  return head.slice(eq + 1);
}

describe("oidc provider — real flow", () => {
  test("finishLogin: issues session row, cookie resolves principal", async () => {
    const provider = buildProvider();

    // 1. Start a login so the provider creates the `oidc_login_states`
    //    row with a real state + PKCE verifier.
    const startUrl = `http://127.0.0.1:0/v1/identity/login/start?tenant=oidc-real`;
    const startRes = await provider.startLogin!(new Request(startUrl));
    expect(startRes.status).toBe(302);
    const authorizeUrl = new URL(startRes.headers.get("location") ?? "");
    const state = authorizeUrl.searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThan(0);

    // 2. Follow the authorize URL so the mock captures the nonce the
    //    engine staged for this login attempt. openid-client's
    //    `authorizationCodeGrant` validates `claims.nonce ===
    //    expectedNonce`, so the mock must echo it back in the eventual
    //    id_token.
    await fetch(authorizeUrl.toString(), { redirect: "manual" });

    // 3. Tell the fixture what claims the next `/token` hop should
    //    mint an id_token for. The mock merges the staged nonce in
    //    during token response assembly.
    const issued = mock.issueFor(
      {
        sub: "mock-sub-1",
        email: "oidc-real@test.local",
      },
      { state, redirect_uri: REDIRECT_URI },
    );

    // 3. Drive the engine's finishLogin.
    const finishRes = await provider.finishLogin!(new Request(issued.callbackUrl));
    expect(finishRes.status).toBe(302);

    const cookie = parseSetCookie(finishRes.headers.get("set-cookie"));
    expect(cookie).not.toBeNull();

    // 4. The sessions row should exist.
    const sessionRows = await testDb.db
      .select()
      .from(sessions)
      .where(eq(sessions.tenant_id, tenantId));
    expect(sessionRows.length).toBeGreaterThan(0);
    const session = sessionRows[sessionRows.length - 1]!;
    expect(session.revoked_at).toBeNull();
    expect(session.absolute_expires_at).not.toBeNull();
    expect(session.last_seen_at).not.toBeNull();

    // 5. A follow-up request carrying the cookie should resolve.
    const resolveRes = await provider.resolve(
      new Request("http://127.0.0.1:0/v1/identity/tenants", {
        headers: { cookie: `subkit_session=${cookie}` },
      }),
    );
    expect(resolveRes).not.toBeNull();
    expect(resolveRes?.tenant_id).toBe(tenantId);
    expect(resolveRes?.kind).toBe("user");
    expect(resolveRes?.session_id).toBe(session.id);

    // Audit trail: session.issued + user.logged_in.
    const auditRows = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_id, session.id)));
    const actions = auditRows.map((r) => r.action);
    expect(actions).toContain("session.issued");
  });

  test("sliding TTL: last_seen_at older than 8h denies with expired_sliding", async () => {
    const provider = buildProvider();
    const startRes = await provider.startLogin!(
      new Request("http://127.0.0.1:0/v1/identity/login/start?tenant=oidc-real"),
    );
    const authorizeUrl = new URL(startRes.headers.get("location") ?? "");
    const state = authorizeUrl.searchParams.get("state") ?? "";
    // Fire a no-redirect fetch at /authorize so the mock stashes the
    // nonce. openid-client's response-processing step will require the
    // id_token to carry that nonce back.
    await fetch(authorizeUrl.toString(), { redirect: "manual" });
    const issued = mock.issueFor(
      { sub: "sliding-sub", email: "sliding@test.local" },
      { state, redirect_uri: REDIRECT_URI },
    );
    const finishRes = await provider.finishLogin!(new Request(issued.callbackUrl));
    const cookie = parseSetCookie(finishRes.headers.get("set-cookie"));
    expect(cookie).not.toBeNull();

    // Fetch the session row we just created and force last_seen_at far
    // into the past.
    const sessionRowList = await testDb.db
      .select()
      .from(sessions)
      .where(eq(sessions.tenant_id, tenantId));
    const row = sessionRowList[sessionRowList.length - 1]!;
    await testDb.db
      .update(sessions)
      .set({ last_seen_at: new Date(TEST_NOW_MS - 9 * 60 * 60 * 1000) })
      .where(eq(sessions.id, row.id));

    const principal = await provider.resolve(
      new Request("http://127.0.0.1:0/v1/identity/tenants", {
        headers: { cookie: `subkit_session=${cookie}` },
      }),
    );
    expect(principal).toBeNull();

    const auditRows = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "session.revoked"),
          eq(auditLog.resource_id, row.id),
        ),
      );
    const reasons = auditRows.map((r) => r.reason);
    expect(reasons).toContain("expired_sliding");
  });

  test("absolute TTL: absolute_expires_at in the past denies with expired_absolute", async () => {
    const provider = buildProvider();
    const startRes = await provider.startLogin!(
      new Request("http://127.0.0.1:0/v1/identity/login/start?tenant=oidc-real"),
    );
    const authorizeUrl = new URL(startRes.headers.get("location") ?? "");
    const state = authorizeUrl.searchParams.get("state") ?? "";
    // Fire a no-redirect fetch at /authorize so the mock stashes the
    // nonce. openid-client's response-processing step will require the
    // id_token to carry that nonce back.
    await fetch(authorizeUrl.toString(), { redirect: "manual" });
    const issued = mock.issueFor(
      { sub: "absolute-sub", email: "absolute@test.local" },
      { state, redirect_uri: REDIRECT_URI },
    );
    const finishRes = await provider.finishLogin!(new Request(issued.callbackUrl));
    const cookie = parseSetCookie(finishRes.headers.get("set-cookie"));

    const sessionRowList = await testDb.db
      .select()
      .from(sessions)
      .where(eq(sessions.tenant_id, tenantId));
    const row = sessionRowList[sessionRowList.length - 1]!;
    await testDb.db
      .update(sessions)
      .set({ absolute_expires_at: new Date(TEST_NOW_MS - 1_000) })
      .where(eq(sessions.id, row.id));

    const principal = await provider.resolve(
      new Request("http://127.0.0.1:0/v1/identity/tenants", {
        headers: { cookie: `subkit_session=${cookie}` },
      }),
    );
    expect(principal).toBeNull();

    const auditRows = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "session.revoked"),
          eq(auditLog.resource_id, row.id),
        ),
      );
    const reasons = auditRows.map((r) => r.reason);
    expect(reasons).toContain("expired_absolute");
  });

  test("revoke: flips revoked_at, subsequent resolve denies with revoked", async () => {
    const provider = buildProvider();
    const startRes = await provider.startLogin!(
      new Request("http://127.0.0.1:0/v1/identity/login/start?tenant=oidc-real"),
    );
    const authorizeUrl = new URL(startRes.headers.get("location") ?? "");
    const state = authorizeUrl.searchParams.get("state") ?? "";
    // Fire a no-redirect fetch at /authorize so the mock stashes the
    // nonce. openid-client's response-processing step will require the
    // id_token to carry that nonce back.
    await fetch(authorizeUrl.toString(), { redirect: "manual" });
    const issued = mock.issueFor(
      { sub: "revoke-sub", email: "revoke@test.local" },
      { state, redirect_uri: REDIRECT_URI },
    );
    const finishRes = await provider.finishLogin!(new Request(issued.callbackUrl));
    const cookie = parseSetCookie(finishRes.headers.get("set-cookie"));

    const revokeRes = await provider.revoke!(
      new Request("http://127.0.0.1:0/v1/identity/logout", {
        method: "POST",
        headers: { cookie: `subkit_session=${cookie}` },
      }),
    );
    expect(revokeRes.status).toBe(204);

    const principal = await provider.resolve(
      new Request("http://127.0.0.1:0/v1/identity/tenants", {
        headers: { cookie: `subkit_session=${cookie}` },
      }),
    );
    expect(principal).toBeNull();

    // The provider-neutral identity binding and user row should still exist.
    const identities = await testDb.db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.tenant_id, tenantId), eq(userIdentities.subject, "revoke-sub")));
    expect(identities).toHaveLength(1);
    if (!identities[0]) throw new Error("provider binding missing");
    const userRows = await testDb.db
      .select()
      .from(users)
      .where(eq(users.id, identities[0].user_id));
    expect(userRows.length).toBe(1);
  });
});

describe("oidc provider — auth.enable_signup gate", () => {
  async function loginAttempt(
    provider: ReturnType<typeof buildProvider>,
    claims: { sub: string; email: string; email_verified?: boolean },
  ): Promise<Response> {
    const startRes = await provider.startLogin!(
      new Request("http://127.0.0.1:0/v1/identity/login/start?tenant=oidc-real"),
    );
    const authorizeUrl = new URL(startRes.headers.get("location") ?? "");
    const state = authorizeUrl.searchParams.get("state") ?? "";
    // The mock must stash the nonce for the eventual id_token.
    await fetch(authorizeUrl.toString(), { redirect: "manual" });
    const issued = mock.issueFor(claims, { state, redirect_uri: REDIRECT_URI });
    return provider.finishLogin!(new Request(issued.callbackUrl));
  }

  test("signup disabled: unknown identity is rejected with the not-authorized page and no user row", async () => {
    const provider = buildProvider({ enableSignup: false });
    const res = await loginAttempt(provider, {
      sub: "gate-new-sub",
      email: "gate-new@test.local",
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("<h1>Sign-in failed</h1>");
    expect(html).toContain("Your account is not authorized for SubKit. Contact the operator.");

    const created = await testDb.db
      .select()
      .from(users)
      .where(and(eq(users.tenant_id, tenantId), eq(users.email, "gate-new@test.local")));
    expect(created).toHaveLength(0);
    const identities = await testDb.db
      .select()
      .from(userIdentities)
      .where(
        and(eq(userIdentities.tenant_id, tenantId), eq(userIdentities.subject, "gate-new-sub")),
      );
    expect(identities).toHaveLength(0);
  });

  test("signup disabled is the default when neither opts nor config provide a value", async () => {
    const provider = createOidcProvider({
      db: testDb.db,
      issuerUrl: mock.url,
      clientId: CLIENT_ID,
      clientSecret: "mock-secret",
      redirectUri: REDIRECT_URI,
    });
    const res = await loginAttempt(provider, {
      sub: "gate-default-sub",
      email: "gate-default@test.local",
    });
    expect(res.status).toBe(403);
  });

  test("signup disabled: an existing user_identities link keeps signing in", async () => {
    // Provision once with signups enabled …
    const first = await loginAttempt(buildProvider({ enableSignup: true }), {
      sub: "gate-existing-sub",
      email: "gate-existing@test.local",
    });
    expect(first.status).toBe(302);
    // … then the same identity logs in fine with signups disabled.
    const second = await loginAttempt(buildProvider({ enableSignup: false }), {
      sub: "gate-existing-sub",
      email: "gate-existing@test.local",
    });
    expect(second.status).toBe(302);
    expect(second.headers.get("set-cookie")).toContain("subkit_session=");
  });

  test("signup disabled: a verified email still links to an EXISTING user without creating one", async () => {
    const [seeded] = await testDb.db
      .insert(users)
      .values({ tenant_id: tenantId, email: "gate-linkable@test.local", role: "member" })
      .returning();
    if (!seeded) throw new Error("seed linkable user failed");

    const res = await loginAttempt(buildProvider({ enableSignup: false }), {
      sub: "gate-linkable-sub",
      email: "gate-linkable@test.local",
      email_verified: true,
    });
    expect(res.status).toBe(302);

    const identities = await testDb.db
      .select()
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.tenant_id, tenantId),
          eq(userIdentities.subject, "gate-linkable-sub"),
        ),
      );
    expect(identities).toHaveLength(1);
    expect(identities[0]?.user_id).toBe(seeded.id);
    const rows = await testDb.db
      .select()
      .from(users)
      .where(and(eq(users.tenant_id, tenantId), eq(users.email, "gate-linkable@test.local")));
    expect(rows).toHaveLength(1);
  });
});

describe("oidc provider — browser error pages", () => {
  async function startAndGetState(provider: ReturnType<typeof buildProvider>): Promise<string> {
    const startRes = await provider.startLogin!(
      new Request("http://127.0.0.1:0/v1/identity/login/start?tenant=oidc-real"),
    );
    expect(startRes.status).toBe(302);
    const authorizeUrl = new URL(startRes.headers.get("location") ?? "");
    const state = authorizeUrl.searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThan(0);
    return state;
  }

  test("unknown state renders the shared HTML error page with a fresh entry point", async () => {
    const provider = buildProvider();
    const res = await provider.finishLogin!(
      new Request(`${REDIRECT_URI}?state=does-not-exist&code=whatever`),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("<h1>Sign-in failed</h1>");
    expect(html).toContain(
      "This sign-in attempt expired or was already used. Please sign in again.",
    );
    expect(html).toContain('href="/v1/identity/login/start"');
    expect(html).toContain(">Sign in again</a>");
    expect(html).toContain('data-auth-contract="mcp-auth-v2"');
  });

  test("unknown state keeps the JSON contract for Accept: application/json", async () => {
    const provider = buildProvider();
    const res = await provider.finishLogin!(
      new Request(`${REDIRECT_URI}?state=does-not-exist&code=whatever`, {
        headers: { accept: "application/json" },
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ code: "unknown_state", message: "state not recognised" });
  });

  test("expired state renders the shared HTML error page", async () => {
    const provider = buildProvider();
    const state = await startAndGetState(provider);
    await testDb.db
      .update(oidcLoginStates)
      .set({ expires_at: new Date(TEST_NOW_MS - 1_000) })
      .where(eq(oidcLoginStates.state, state));
    const res = await provider.finishLogin!(
      new Request(`${REDIRECT_URI}?state=${encodeURIComponent(state)}&code=whatever`),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("<h1>Sign-in failed</h1>");
    expect(html).toContain(
      "This sign-in attempt expired or was already used. Please sign in again.",
    );
  });

  test("IdP access_denied renders the not-authorized page", async () => {
    const provider = buildProvider();
    const state = await startAndGetState(provider);
    const res = await provider.finishLogin!(
      new Request(`${REDIRECT_URI}?state=${encodeURIComponent(state)}&error=access_denied`),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("<h1>Sign-in failed</h1>");
    expect(html).toContain("Your account is not authorized for SubKit. Contact the operator.");
    expect(html).toContain(">Sign in again</a>");
  });

  test("code-exchange failure renders HTML and retries at the safe authorize re-entry", async () => {
    const provider = buildProvider();
    const state = await startAndGetState(provider);
    const reentry = "/v1/oauth/authorize?client_id=demo";
    await testDb.db
      .update(oidcLoginStates)
      .set({ redirect_to: reentry })
      .where(eq(oidcLoginStates.state, state));
    const res = await provider.finishLogin!(
      new Request(`${REDIRECT_URI}?state=${encodeURIComponent(state)}&code=bogus-code`),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("<h1>Sign-in failed</h1>");
    expect(html).toContain(`href="${reentry}"`);
  });
});
