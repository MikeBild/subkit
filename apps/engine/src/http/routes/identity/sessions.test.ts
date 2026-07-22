// POST /v1/identity/sessions — provider-neutral security regression suite.
//
// This route is public (no API key needed — the signed assertion is the authn) and
// mints a personal API key. Before the E0 hardening it accepted ANY issuer,
// performed no audience check, and rebound an existing user's identity
// to whatever `email` claim the token carried — an unauthenticated account
// takeover. These tests pin the closed contract:
//   1. provider_id must identify one configured adapter;
//   2. an unconfigured provider → 403 (route is inert, not open);
//   3. audience must equal that adapter's client_id;
//   4. an unverified `email` claim cannot link to (hijack) another account;
//   5. a verified email already bound to a different OIDC subject is refused.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  type MockOidcHandle,
  startMockOidc,
} from "../../../auth/providers/tests/fixtures/mock-oidc.ts";
import { _resetConfigForTests, loadConfig } from "../../../config/loader.ts";
import { tenants, userIdentities, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { flushDiscoveryCache } from "../../../identity/index.ts";
import { buildDefaultRegistry, createApp } from "../../server.ts";

let testDb: TestDb;
let mock: MockOidcHandle;
let app: ReturnType<typeof createApp>;
let configDir: string;
let defaultTenantId = "";

const CLIENT_ID = "mock-client";
const ENDPOINT = "http://127.0.0.1/v1/identity/sessions";

async function writeOidcConfig(issuerUrl: string, clientId: string): Promise<void> {
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
        },
      ]
    : [{ protocol: "api_key", id: "api-key", label: "SubKit API key" }];
  await writeFile(file, JSON.stringify({ auth: { providers } }));
  await loadConfig({
    env: { DATABASE_URL: testDb.url, NODE_ENV: "test" },
    configPathOverride: file,
  });
}

async function writeTokenBridgeConfig(): Promise<void> {
  const file = join(configDir, "subkit.config.json");
  await writeFile(
    file,
    JSON.stringify({
      auth: {
        providers: [
          { protocol: "api_key", id: "api-key", label: "SubKit API key" },
          {
            protocol: "token_bridge",
            id: "test-bridge",
            label: "Test bridge",
            login_url: `${mock.url}/login`,
            issuer_url: mock.url,
            audience: CLIENT_ID,
            jwks_url: `${mock.url}/jwks`,
            tenant_slug: "default",
          },
        ],
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
  configDir = mkdtempSync(join(tmpdir(), "sk-identity-sessions-"));
  await writeOidcConfig(mock.url, CLIENT_ID);

  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "default", display_name: "Default" })
    .returning();
  if (!t) throw new Error("seed default tenant failed");
  defaultTenantId = t.id;

  const registry = buildDefaultRegistry(testDb.db);
  app = createApp({ db: testDb.db, registry });
});

afterAll(async () => {
  try {
    await mock.stop();
  } catch {
    /* ignore */
  }
  if (testDb) await testDb.cleanup();
  _resetConfigForTests();
});

afterEach(async () => {
  // Reset the allow-list to the configured mock between tests and drop any
  // users created by a test so email-uniqueness doesn't bleed across cases.
  flushDiscoveryCache();
  await writeOidcConfig(mock.url, CLIENT_ID);
  await testDb.db.delete(users).where(eq(users.tenant_id, defaultTenantId));
});

describe("POST /v1/identity/sessions — configured provider boundary", () => {
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
    const json = (await res.json()) as { api_key: string; user_id: string };
    expect(json.api_key.length).toBeGreaterThan(0);

    const [row] = await testDb.db.select().from(users).where(eq(users.id, json.user_id));
    expect(row?.email).toBe("user-1@example.test");
    const [identity] = await testDb.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, json.user_id));
    expect(identity?.provider_id).toBe("test-identity");
    expect(identity?.subject).toBe("user-1");
  });

  test("token bridge adapter uses the same generic exchange route", async () => {
    await writeTokenBridgeConfig();
    const identityToken = await mock.signIdToken({
      sub: "bridge-user",
      email: "bridge-user@example.test",
      email_verified: true,
    });
    const res = await postIdentity({ provider_id: "test-bridge", identity_token: identityToken });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { api_key: string; user_id: string };
    expect(json.api_key.length).toBeGreaterThan(0);
    const [identity] = await testDb.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, json.user_id));
    expect(identity?.provider_id).toBe("test-bridge");
    expect(identity?.subject).toBe("bridge-user");
  });

  test("unknown provider id is rejected with 403", async () => {
    const id_token = await mock.signIdToken({ sub: "attacker", email_verified: true });
    const res = await postIdentity({ provider_id: "attacker", identity_token: id_token });
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
    // Seed a victim admin whose email the attacker will claim.
    const [admin] = await testDb.db
      .insert(users)
      .values({
        tenant_id: defaultTenantId,
        email: "admin@victim.test",
        role: "admin",
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
    const json = (await res.json()) as { user_id: string };

    // The attacker got their OWN account, not the admin's.
    expect(json.user_id).not.toBe(admin.id);
    const [adminAfter] = await testDb.db.select().from(users).where(eq(users.id, admin.id));
    expect(adminAfter?.role).toBe("admin");
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
        role: "member",
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
