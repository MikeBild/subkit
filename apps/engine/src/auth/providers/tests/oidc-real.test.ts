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
import { builtinRoleId } from "../../../rbac/roles.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { createBrowserSessionProvider } from "../browser-session.ts";
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
  } catch {}
  if (testDb) await testDb.cleanup();
});

function buildProvider(
  overrides: { enableSignup?: boolean; productId?: string; linkByEmail?: boolean } = {},
) {
  return createOidcProvider({
    db: testDb.db,
    issuerUrl: mock.url,
    clientId: CLIENT_ID,
    clientSecret: "mock-secret",
    redirectUri: REDIRECT_URI,
    tenantSlug: "oidc-real",
    enableSignup: overrides.enableSignup ?? true,
    ...(overrides.productId ? { productId: overrides.productId } : {}),
    ...(overrides.linkByEmail !== undefined ? { linkByEmail: overrides.linkByEmail } : {}),
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
    const provider = buildProvider({ productId: "harmoniqs" });
    const [owner] = await testDb.db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: "oidc-real@test.local",
        role_id: await builtinRoleId(testDb.db, "member"),
      })
      .returning();
    if (!owner) throw new Error("owner seed failed");
    await testDb.db.insert(userIdentities).values({
      tenant_id: tenantId,
      user_id: owner.id,
      provider_id: "oidc",
      subject: "mock-sub-1",
      email: owner.email,
      issuer_url: mock.url,
      product_id: "harmoniqs",
    });

    const startUrl = `http://127.0.0.1:0/v1/identity/login/start?tenant=oidc-real`;
    const startRes = await provider.startLogin!(new Request(startUrl));
    expect(startRes.status).toBe(302);
    const authorizeUrl = new URL(startRes.headers.get("location") ?? "");
    const state = authorizeUrl.searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThan(0);

    await fetch(authorizeUrl.toString(), { redirect: "manual" });

    const issued = mock.issueFor(
      {
        sub: "mock-sub-1",
        email: "oidc-real@test.local",
      },
      { state, redirect_uri: REDIRECT_URI },
    );

    const finishRes = await provider.finishLogin!(new Request(issued.callbackUrl));
    expect(finishRes.status).toBe(302);

    const cookie = parseSetCookie(finishRes.headers.get("set-cookie"));
    expect(cookie).not.toBeNull();
    const claims = JSON.parse(
      Buffer.from(decodeURIComponent(cookie ?? "").split(".")[1] ?? "", "base64url").toString(),
    );
    expect(typeof claims.login_provider).toBe("string");

    const sessionRows = await testDb.db
      .select()
      .from(sessions)
      .where(eq(sessions.tenant_id, tenantId));
    expect(sessionRows.length).toBeGreaterThan(0);
    const session = sessionRows[sessionRows.length - 1]!;
    expect(session.revoked_at).toBeNull();
    expect(session.absolute_expires_at).not.toBeNull();
    expect(session.last_seen_at).not.toBeNull();
    expect(session.product_id).toBe("harmoniqs");

    const resolveRes = await provider.resolve(
      new Request("http://127.0.0.1:0/v1/identity/tenants", {
        headers: { cookie: `subkit_session=${cookie}` },
      }),
    );
    expect(resolveRes).not.toBeNull();
    expect(resolveRes?.tenant_id).toBe(tenantId);
    expect(resolveRes?.kind).toBe("user");
    expect(resolveRes?.session_id).toBe(session.id);
    expect(resolveRes?.product_id).toBe("harmoniqs");

    const browserPrincipal = await createBrowserSessionProvider({ db: testDb.db }).resolve(
      new Request("http://127.0.0.1:0/v1/executions", {
        headers: { cookie: `subkit_session=${cookie}` },
      }),
    );
    expect(browserPrincipal?.product_id).toBe("harmoniqs");
    expect(browserPrincipal?.id).toBe(resolveRes?.id);

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
    await fetch(authorizeUrl.toString(), { redirect: "manual" });
    const issued = mock.issueFor(
      { sub: "sliding-sub", email: "sliding@test.local" },
      { state, redirect_uri: REDIRECT_URI },
    );
    const finishRes = await provider.finishLogin!(new Request(issued.callbackUrl));
    const cookie = parseSetCookie(finishRes.headers.get("set-cookie"));
    expect(cookie).not.toBeNull();

    const [identity] = await testDb.db
      .select()
      .from(userIdentities)
      .where(
        and(eq(userIdentities.tenant_id, tenantId), eq(userIdentities.subject, "sliding-sub")),
      );
    if (!identity) throw new Error("sliding identity missing");
    const [row] = await testDb.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenant_id, tenantId), eq(sessions.user_id, identity.user_id)));
    if (!row) throw new Error("sliding session missing");
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
    const expiry = auditRows.find((row) => row.reason === "expired_sliding");
    if (!expiry) throw new Error("expiry audit missing");
    expect(expiry.actor_type).toBe("system");
    expect(expiry.actor_id).toBeNull();
    expect((expiry.metadata as Record<string, unknown>).subject_user_id).toBe(row.user_id);
  });

  test("absolute TTL: absolute_expires_at in the past denies with expired_absolute", async () => {
    const provider = buildProvider();
    const startRes = await provider.startLogin!(
      new Request("http://127.0.0.1:0/v1/identity/login/start?tenant=oidc-real"),
    );
    const authorizeUrl = new URL(startRes.headers.get("location") ?? "");
    const state = authorizeUrl.searchParams.get("state") ?? "";
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
    expect(html).toMatch(
      /<h1\b[^>]*data-family-slot="auth-heading"[^>]*>Account not assigned<\/h1>/,
    );
    expect(html).toContain(
      "This company account is not assigned to SubKit. Contact an administrator.",
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-testid="auth-retry"');

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
      tenantSlug: "oidc-real",
    });
    const res = await loginAttempt(provider, {
      sub: "gate-default-sub",
      email: "gate-default@test.local",
    });
    expect(res.status).toBe(403);
  });

  test("signup disabled: an existing user_identities link keeps signing in", async () => {
    const first = await loginAttempt(buildProvider({ enableSignup: true }), {
      sub: "gate-existing-sub",
      email: "gate-existing@test.local",
    });
    expect(first.status).toBe(302);
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
      .values({
        tenant_id: tenantId,
        email: "gate-linkable@test.local",
        role_id: await builtinRoleId(testDb.db, "member"),
      })
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

  test("a mismatched tenant is rejected before creating an OIDC login state", async () => {
    const [foreignTenant] = await testDb.db
      .insert(tenants)
      .values({ slug: "oidc-foreign", display_name: "OIDC Foreign" })
      .returning();
    if (!foreignTenant) throw new Error("foreign tenant seed failed");
    const provider = buildProvider();
    const url = "http://127.0.0.1:0/v1/identity/login/start?tenant=oidc-foreign";
    const before = await testDb.db.select({ id: oidcLoginStates.id }).from(oidcLoginStates);

    const browserRes = await provider.startLogin!(new Request(url));
    expect(browserRes.status).toBe(400);
    expect(browserRes.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await browserRes.text();
    expect(html).toContain(">Sign-in failed</h1>");
    expect(html).toContain("This sign-in provider is not available for this tenant.");
    expect(html).not.toStartWith("{");

    const jsonRes = await provider.startLogin!(
      new Request(url, { headers: { accept: "application/json" } }),
    );
    expect(jsonRes.status).toBe(400);
    expect(jsonRes.headers.get("content-type")).toBe("application/json");
    expect(await jsonRes.json()).toEqual({
      code: "tenant_mismatch",
      message: "tenant does not match configured sign-in target",
    });
    expect(await testDb.db.select({ id: oidcLoginStates.id }).from(oidcLoginStates)).toEqual(
      before,
    );
  });

  test("discovery failure renders HTML while explicit JSON clients keep the error envelope", async () => {
    const provider = createOidcProvider({
      db: testDb.db,
      issuerUrl: "http://127.0.0.1:1",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      tenantSlug: "oidc-real",
    });
    const url = "http://127.0.0.1:0/v1/identity/login/start";

    const browserRes = await provider.startLogin!(new Request(url));
    expect(browserRes.status).toBe(502);
    expect(browserRes.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await browserRes.text();
    expect(html).toContain(">Sign-in failed</h1>");
    expect(html).toContain("The sign-in provider is temporarily unavailable.");
    expect(html).not.toStartWith("{");

    const jsonRes = await provider.startLogin!(
      new Request(url, { headers: { accept: "application/json" } }),
    );
    expect(jsonRes.status).toBe(502);
    expect(jsonRes.headers.get("content-type")).toBe("application/json");
    expect(await jsonRes.json()).toEqual({
      code: "oidc_discovery_failed",
      message: "issuer discovery failed",
    });
  });

  test("unknown state renders the shared HTML error page with a fresh entry point", async () => {
    const provider = buildProvider();
    const res = await provider.finishLogin!(
      new Request(`${REDIRECT_URI}?state=does-not-exist&code=whatever`),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain(">Sign-in failed</h1>");
    expect(html).toContain(
      "This sign-in attempt expired or was already used. Please sign in again.",
    );
    expect(html).toContain('href="/v1/identity/login/start"');
    expect(html).toContain(">Sign in again</a>");
    expect(html).toContain('data-auth-contract="mcp-auth"');
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
    expect(html).toContain(">Sign-in failed</h1>");
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
    expect(html).toContain(">Sign-in failed</h1>");
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
    expect(html).toContain(">Sign-in failed</h1>");
    expect(html).toContain(`href="${reentry}"`);
  });
});

test("product callback refuses verified email signup even with signup enabled", async () => {
  const provider = buildProvider({ productId: "product-prebound", enableSignup: true });
  const start = await provider.startLogin!(
    new Request("http://127.0.0.1:0/v1/identity/login/start?tenant=oidc-real"),
  );
  const authorize = new URL(start.headers.get("location") ?? "");
  await fetch(authorize, { redirect: "manual" });
  const issued = mock.issueFor(
    { sub: "product-unbound-subject", email: "product-new@example.test", email_verified: true },
    { state: authorize.searchParams.get("state") ?? "", redirect_uri: REDIRECT_URI },
  );
  const response = await provider.finishLogin!(
    new Request(issued.callbackUrl, { headers: { accept: "application/json" } }),
  );
  expect(response.status).toBe(403);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(
    await testDb.db
      .select()
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.tenant_id, tenantId),
          eq(userIdentities.subject, "product-unbound-subject"),
        ),
      ),
  ).toHaveLength(0);
  expect(
    await testDb.db
      .select()
      .from(users)
      .where(and(eq(users.tenant_id, tenantId), eq(users.email, "product-new@example.test"))),
  ).toHaveLength(0);
});

test("unbound callback email opt out never inherits an existing account", async () => {
  const [owner] = await testDb.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "optout@example.test",
      role_id: await builtinRoleId(testDb.db, "admin"),
    })
    .returning();
  if (!owner) throw new Error("owner seed failed");
  const provider = buildProvider({ enableSignup: true, linkByEmail: false });
  const start = await provider.startLogin!(
    new Request("http://127.0.0.1:0/v1/identity/login/start?tenant=oidc-real"),
  );
  const authorize = new URL(start.headers.get("location") ?? "");
  await fetch(authorize, { redirect: "manual" });
  const issued = mock.issueFor(
    { sub: "optout-subject", email: owner.email, email_verified: true },
    { state: authorize.searchParams.get("state") ?? "", redirect_uri: REDIRECT_URI },
  );
  const response = await provider.finishLogin!(
    new Request(issued.callbackUrl, { headers: { accept: "application/json" } }),
  );
  expect(response.status).toBe(403);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(
    await testDb.db
      .select()
      .from(userIdentities)
      .where(
        and(eq(userIdentities.tenant_id, tenantId), eq(userIdentities.subject, "optout-subject")),
      ),
  ).toHaveLength(0);
});
