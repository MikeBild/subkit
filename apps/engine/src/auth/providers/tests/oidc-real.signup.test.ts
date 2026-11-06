import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { tenants, userIdentities, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { createOidcProvider } from "../oidc.ts";
import { type MockOidcHandle, startMockOidc } from "./fixtures/mock-oidc.ts";
import { CLIENT_ID, oidcRealFixtures, REDIRECT_URI } from "./oidc-real-fixtures.ts";

let testDb: TestDb;

let mock: MockOidcHandle;

let tenantId = "";

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

const { buildProvider } = oidcRealFixtures({
  get testDb() {
    return testDb;
  },
  get mock() {
    return mock;
  },
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
