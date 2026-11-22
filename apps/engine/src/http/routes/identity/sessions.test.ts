import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../../audit/types.ts";
import { verifyLoginState } from "../../../auth/index.ts";
import {
  type MockOidcHandle,
  startMockOidc,
} from "../../../auth/providers/tests/fixtures/mock-oidc.ts";
import { _resetConfigForTests, loadConfig } from "../../../config/loader.ts";
import { auditLog, userIdentities, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { flushDiscoveryCache } from "../../../identity/index.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { buildDefaultRegistry, createApp } from "../../server.ts";

let testDb: TestDb;
let mock: MockOidcHandle;
let app: ReturnType<typeof createApp>;
let configDir: string;
let defaultTenantId = "";

const CLIENT_ID = "mock-client";
const ENDPOINT = "http://127.0.0.1/v1/identity/sessions";

async function writeOidcConfig(
  issuerUrl: string,
  clientId: string,
  opts: {
    enableSignup?: boolean;
    productId?: string;
    linkByEmail?: boolean;
    selfService?: boolean;
  } = {},
): Promise<void> {
  const file = join(configDir, "subkit.config.json");
  const providers = issuerUrl
    ? [
        { protocol: "api_key", id: "api-key", label: "SubKit API key" },
        {
          protocol: "oidc",
          id: "test-identity",
          label: "Test identity",
          issuer_url: issuerUrl,
          client_id: clientId,
          tenant_slug: "default",
          ...(opts.selfService ? { signup_policy: "self_service" } : {}),
          ...(opts.productId ? { product_id: opts.productId } : {}),
          ...(opts.linkByEmail !== undefined ? { link_by_email: opts.linkByEmail } : {}),
        },
      ]
    : [{ protocol: "api_key", id: "api-key", label: "SubKit API key" }];
  const enable_signup = opts.enableSignup ?? true;
  await writeFile(
    file,
    JSON.stringify({
      ...(opts.selfService
        ? {
            server: {
              public_base_url: "http://127.0.0.1",
              hosted_rate_limit: {
                peer_per_minute: 1000,
                global_per_minute: 10000,
                tenant_per_minute: 1000,
                tenant_per_month: 10000,
                principal_per_minute: 1000,
              },
            },
          }
        : {}),
      auth: {
        providers,
        enable_signup,
        ...(opts.selfService ? { hosted: { enabled: true } } : {}),
      },
    }),
  );
  await loadConfig({
    env: { DATABASE_URL: testDb.url, NODE_ENV: "test" },
    configPathOverride: file,
  });
}

async function postIdentity(body: unknown): Promise<Response> {
  return app.request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  testDb = await createTestDb("identity-sessions");
  mock = await startMockOidc();
  configDir = mkdtempSync(join(tmpdir(), "subkit-identity-sessions-"));
  await writeOidcConfig(mock.url, CLIENT_ID);

  const t = await seedTenant(testDb.db, { slug: "default", display_name: "Default" });
  defaultTenantId = t.id;

  const registry = buildDefaultRegistry(testDb.db);
  app = createApp({ db: testDb.db, registry });
});

afterAll(async () => {
  try {
    await mock.stop();
  } catch {}
  if (testDb) await testDb.cleanup();
  _resetConfigForTests();
});

afterEach(async () => {
  flushDiscoveryCache();
  await writeOidcConfig(mock.url, CLIENT_ID);
  await testDb.db.delete(users).where(eq(users.tenant_id, defaultTenantId));
});

describe("POST /v1/identity/sessions — configured provider boundary", () => {
  test("hosted assertions hand off to a signed browser login without trusting or echoing the assertion", async () => {
    await writeOidcConfig(mock.url, CLIENT_ID, { selfService: true });
    const response = await postIdentity({
      provider_id: "test-identity",
      identity_token: "untrusted-assertion-canary",
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; continuation_url: string };
    expect(body.error).toBe("browser_login_required");
    expect(JSON.stringify(body)).not.toContain("untrusted-assertion-canary");
    const continuation = new URL(body.continuation_url);
    expect(continuation.pathname).toBe("/v1/identity/login/start");
    expect(continuation.searchParams.get("provider")).toBe("test-identity");
    expect(
      (await verifyLoginState(continuation.searchParams.get("login_state") ?? ""))?.redirect_to,
    ).toBe("/cockpit");
    const login = await app.request(continuation.toString());
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toContain(mock.url);
  });

  test("the generic browser callback rejects missing state as input, not as a missing route", async () => {
    const res = await app.request("http://127.0.0.1/v1/identity/login/callback");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain(">Sign-in failed</h1>");
    expect(html).toContain("This sign-in attempt expired or was already used.");
    expect(html).toContain('href="/v1/identity/login/start"');
    expect(html).toContain('data-auth-contract="mcp-auth"');
  });

  test("a login start without a state is a fresh sign-in, not a dead end", async () => {
    const res = await app.request("http://127.0.0.1/v1/identity/login/start");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).not.toContain(">Sign-in failed</h1>");
    expect(html).toMatch(/login_state=[^"&]+/);
  });

  test("the generic browser callback rejects an unknown state provider prefix as 400 invalid state", async () => {
    const res = await app.request("http://127.0.0.1/v1/identity/login/callback?state=zz.bogus");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain(">Sign-in failed</h1>");
    expect(html).toContain("This sign-in attempt expired or was already used.");
    expect(html).toContain('href="/v1/identity/login/start"');
  });

  test("the generic browser callback answers the unknown provider prefix as 400 JSON on request", async () => {
    const res = await app.request("http://127.0.0.1/v1/identity/login/callback?state=zz.bogus", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "provider_not_found" });
  });

  test("the generic browser callback still answers JSON when the client asks for it", async () => {
    const res = await app.request("http://127.0.0.1/v1/identity/login/callback", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "invalid_state" });
  });

  test("only the exact provider-neutral route exists", async () => {
    const res = await app.request(`${ENDPOINT}/oidc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_id: "test-identity", identity_token: "unused" }),
    });
    expect(res.status).toBe(404);
  });

  test("OIDC adapter: configured issuer + audience mints a key and creates the user", async () => {
    const identityToken = await mock.signIdToken({
      sub: "user-1",
      email: "user-1@example.test",
      email_verified: true,
    });
    const res = await postIdentity({
      provider_id: "test-identity",
      identity_token: identityToken,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { api_key: string; principal_id: string };
    expect(json.api_key.length).toBeGreaterThan(0);

    const [row] = await testDb.db.select().from(users).where(eq(users.id, json.principal_id));
    expect(row?.email).toBe("user-1@example.test");
    const [identity] = await testDb.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, json.principal_id));
    expect(identity?.provider_id).toBe("test-identity");
    expect(identity?.subject).toBe("user-1");
  });

  test("a sign-in from the subkit CLI records sk_cli.login, any other client does not", async () => {
    async function signIn(subject: string, userAgent: string): Promise<string> {
      const identityToken = await mock.signIdToken({
        sub: subject,
        email: `${subject}@example.test`,
        email_verified: true,
      });
      const res = await app.request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": userAgent },
        body: JSON.stringify({ provider_id: "test-identity", identity_token: identityToken }),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { principal_id: string }).principal_id;
    }
    async function cliLogins(principalId: string) {
      return testDb.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, AuditAction.SUBKIT_CLI_LOGIN),
            eq(auditLog.actor_id, principalId),
          ),
        );
    }

    const cliUser = await signIn("cli-user", "subkit-cli/0.0.1");
    const cliRows = await cliLogins(cliUser);
    expect(cliRows).toHaveLength(1);
    expect(cliRows[0]?.metadata).toMatchObject({ user_agent: "subkit-cli/0.0.1" });

    const browserUser = await signIn("browser-user", "subkit/0.0.1");
    expect(await cliLogins(browserUser)).toHaveLength(0);
  });

  test("unknown provider id is rejected with 403", async () => {
    const id_token = await mock.signIdToken({ sub: "attacker", email_verified: true });
    const res = await postIdentity({ provider_id: "attacker", identity_token: id_token });
    expect(res.status).toBe(403);
  });

  test("product identity cannot mint an unbound API key", async () => {
    await writeOidcConfig(mock.url, CLIENT_ID, { productId: "harmoniqs" });
    const res = await postIdentity({
      provider_id: "test-identity",
      identity_token: "unused",
    });
    expect(res.status).toBe(403);
  });

  test("unconfigured OIDC → 403 (route is inert, not an open key faucet)", async () => {
    await writeOidcConfig("", "");
    const id_token = await mock.signIdToken({ sub: "anyone", email_verified: true });
    const res = await postIdentity({ provider_id: "test-identity", identity_token: id_token });
    expect(res.status).toBe(403);
  });

  test("audience mismatch is rejected with 401", async () => {
    const id_token = await mock.signIdToken(
      { sub: "user-2", email_verified: true },
      { audience: "some-other-client" },
    );
    const res = await postIdentity({ provider_id: "test-identity", identity_token: id_token });
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/identity/sessions — account-takeover guards", () => {
  test("unverified email cannot hijack an existing account", async () => {
    const [admin] = await testDb.db
      .insert(users)
      .values({
        tenant_id: defaultTenantId,
        email: "admin@victim.test",
        role_id: await builtinRoleId(testDb.db, "admin"),
      })
      .returning();
    if (!admin) throw new Error("seed admin failed");

    const id_token = await mock.signIdToken({
      sub: "attacker-sub",
      email: "admin@victim.test",
      email_verified: false,
    });
    const res = await postIdentity({ provider_id: "test-identity", identity_token: id_token });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { principal_id: string; email: string | null };

    expect(json.principal_id).not.toBe(admin.id);
    expect(json.email).toBeNull();
    const [adminAfter] = await testDb.db.select().from(users).where(eq(users.id, admin.id));
    expect(adminAfter?.role_id).toBe(await builtinRoleId(testDb.db, "admin"));
    const adminIdentities = await testDb.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, admin.id));
    expect(adminIdentities).toHaveLength(0);
  });

  test("verified email already bound to a different subject is refused with 403", async () => {
    const [bound] = await testDb.db
      .insert(users)
      .values({
        tenant_id: defaultTenantId,
        email: "bound@victim.test",
        role_id: await builtinRoleId(testDb.db, "member"),
      })
      .returning();
    if (!bound) throw new Error("seed bound user failed");
    await testDb.db.insert(userIdentities).values({
      tenant_id: defaultTenantId,
      user_id: bound.id,
      provider_id: "test-identity",
      subject: "legit-sub",
      email: bound.email,
    });

    const id_token = await mock.signIdToken({
      sub: "attacker-sub",
      email: "bound@victim.test",
      email_verified: true,
    });
    const res = await postIdentity({ provider_id: "test-identity", identity_token: id_token });
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/identity/sessions — auth.enable_signup gate", () => {
  test("signup disabled: unknown identity is refused with 403 access_denied and no user row", async () => {
    await writeOidcConfig(mock.url, CLIENT_ID, { enableSignup: false });
    const id_token = await mock.signIdToken({
      sub: "gate-sessions-new",
      email: "gate-sessions-new@example.test",
      email_verified: true,
    });
    const res = await postIdentity({ provider_id: "test-identity", identity_token: id_token });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("access_denied");

    const rows = await testDb.db
      .select()
      .from(users)
      .where(eq(users.email, "gate-sessions-new@example.test"));
    expect(rows).toHaveLength(0);
  });

  test("signup disabled: an existing user_identities link still mints a key", async () => {
    const [existing] = await testDb.db
      .insert(users)
      .values({
        tenant_id: defaultTenantId,
        email: "gate-sessions-linked@example.test",
        role_id: await builtinRoleId(testDb.db, "member"),
      })
      .returning();
    if (!existing) throw new Error("seed user failed");
    await testDb.db.insert(userIdentities).values({
      tenant_id: defaultTenantId,
      user_id: existing.id,
      provider_id: "test-identity",
      subject: "gate-sessions-linked",
      email: existing.email,
    });

    await writeOidcConfig(mock.url, CLIENT_ID, { enableSignup: false });
    const id_token = await mock.signIdToken({
      sub: "gate-sessions-linked",
      email: "gate-sessions-linked@example.test",
      email_verified: true,
    });
    const res = await postIdentity({ provider_id: "test-identity", identity_token: id_token });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { principal_id: string };
    expect(json.principal_id).toBe(existing.id);
  });

  test("signup disabled: a verified email still links an EXISTING user without creating one", async () => {
    const [existing] = await testDb.db
      .insert(users)
      .values({
        tenant_id: defaultTenantId,
        email: "gate-sessions-email@example.test",
        role_id: await builtinRoleId(testDb.db, "member"),
      })
      .returning();
    if (!existing) throw new Error("seed user failed");

    await writeOidcConfig(mock.url, CLIENT_ID, { enableSignup: false });
    const id_token = await mock.signIdToken({
      sub: "gate-sessions-email-sub",
      email: "gate-sessions-email@example.test",
      email_verified: true,
    });
    const res = await postIdentity({ provider_id: "test-identity", identity_token: id_token });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { principal_id: string };
    expect(json.principal_id).toBe(existing.id);
    const rows = await testDb.db
      .select()
      .from(users)
      .where(eq(users.email, "gate-sessions-email@example.test"));
    expect(rows).toHaveLength(1);
  });

  test("signup enabled: a brand-new identity still provisions a member (previous behavior)", async () => {
    await writeOidcConfig(mock.url, CLIENT_ID, { enableSignup: true });
    const id_token = await mock.signIdToken({
      sub: "gate-sessions-jit",
      email: "gate-sessions-jit@example.test",
      email_verified: true,
    });
    const res = await postIdentity({ provider_id: "test-identity", identity_token: id_token });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { principal_id: string };
    const [row] = await testDb.db.select().from(users).where(eq(users.id, json.principal_id));
    expect(row?.role_id).toBe(await builtinRoleId(testDb.db, "member"));
  });
});

test("configured email opt out refuses token exchange into an existing user", async () => {
  await writeOidcConfig(mock.url, CLIENT_ID, { linkByEmail: false, enableSignup: true });
  const [owner] = await testDb.db
    .insert(users)
    .values({
      tenant_id: defaultTenantId,
      email: "optout-existing@example.test",
      role_id: await builtinRoleId(testDb.db, "admin"),
    })
    .returning();
  if (!owner) throw new Error("owner seed failed");
  const token = await mock.signIdToken({
    sub: "optout-assertion",
    email: owner.email,
    email_verified: true,
  });
  const response = await postIdentity({ provider_id: "test-identity", identity_token: token });
  expect(response.status).toBe(403);
  expect(
    await testDb.db.select().from(userIdentities).where(eq(userIdentities.user_id, owner.id)),
  ).toHaveLength(0);
});
