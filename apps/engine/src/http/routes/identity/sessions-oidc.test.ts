// POST /v1/identity/sessions/oidc — security regression suite.
//
// This route is public (no API key needed — the id_token IS the authn) and
// mints a personal API key. Before the E0 hardening it accepted ANY issuer,
// performed no audience check, and rebound an existing user's `oidc_subject`
// to whatever `email` claim the token carried — an unauthenticated account
// takeover. These tests pin the closed contract:
//   1. issuer must equal the operator-configured `auth.oidc.issuer_url`;
//   2. unconfigured OIDC → 403 (route is inert, not open);
//   3. audience must equal `auth.oidc.client_id`;
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
import { tenants, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { flushDiscoveryCache } from "../../../identity/index.ts";
import { buildDefaultRegistry, createApp } from "../../server.ts";

let testDb: TestDb;
let mock: MockOidcHandle;
let app: ReturnType<typeof createApp>;
let configDir: string;
let defaultTenantId = "";

const CLIENT_ID = "mock-client";
const ENDPOINT = "http://127.0.0.1/v1/identity/sessions/oidc";

async function writeOidcConfig(issuerUrl: string, clientId: string): Promise<void> {
  const file = join(configDir, "subkit.config.json");
  await writeFile(
    file,
    JSON.stringify({ auth: { oidc: { issuer_url: issuerUrl, client_id: clientId } } }),
  );
  await loadConfig({
    env: { DATABASE_URL: testDb.url, NODE_ENV: "test" },
    configPathOverride: file,
  });
}

async function postOidc(body: unknown): Promise<Response> {
  return app.request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  testDb = await createTestDb("sessions-oidc");
  mock = await startMockOidc();
  configDir = mkdtempSync(join(tmpdir(), "sk-sessions-oidc-"));
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

describe("POST /v1/identity/sessions/oidc — issuer allow-list", () => {
  test("happy path: configured issuer + audience mints a key and creates the user", async () => {
    const id_token = await mock.signIdToken({
      sub: "user-1",
      email: "user-1@example.test",
      email_verified: true,
    });
    const res = await postOidc({ id_token, issuer: mock.url });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { api_key: string; user_id: string; sub: string };
    expect(json.api_key.length).toBeGreaterThan(0);
    expect(json.sub).toBe("user-1");

    const [row] = await testDb.db.select().from(users).where(eq(users.id, json.user_id));
    expect(row?.oidc_subject).toBe("user-1");
    expect(row?.email).toBe("user-1@example.test");
  });

  test("forged issuer (not the configured one) is rejected with 403", async () => {
    // Token is validly signed by the mock, but the body issuer points
    // elsewhere — the allow-list must refuse before any key is minted.
    const id_token = await mock.signIdToken({ sub: "attacker", email_verified: true });
    const res = await postOidc({ id_token, issuer: "https://evil.example.com" });
    expect(res.status).toBe(403);
  });

  test("unconfigured OIDC → 403 (route is inert, not an open key faucet)", async () => {
    await writeOidcConfig("", "");
    const id_token = await mock.signIdToken({ sub: "anyone", email_verified: true });
    const res = await postOidc({ id_token, issuer: mock.url });
    expect(res.status).toBe(403);
  });

  test("audience mismatch is rejected with 401", async () => {
    const id_token = await mock.signIdToken(
      { sub: "user-2", email_verified: true },
      { audience: "some-other-client" },
    );
    const res = await postOidc({ id_token, issuer: mock.url });
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/identity/sessions/oidc — account-takeover guards", () => {
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
    const res = await postOidc({ id_token, issuer: mock.url });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { user_id: string };

    // The attacker got their OWN account, not the admin's.
    expect(json.user_id).not.toBe(admin.id);
    const [adminAfter] = await testDb.db.select().from(users).where(eq(users.id, admin.id));
    expect(adminAfter?.oidc_subject).toBeNull();
    expect(adminAfter?.role).toBe("admin");
  });

  test("verified email already bound to a different subject is refused with 403", async () => {
    await testDb.db.insert(users).values({
      tenant_id: defaultTenantId,
      email: "bound@victim.test",
      role: "member",
      oidc_subject: "legit-sub",
    });

    const id_token = await mock.signIdToken({
      sub: "attacker-sub",
      email: "bound@victim.test",
      email_verified: true,
    });
    const res = await postOidc({ id_token, issuer: mock.url });
    expect(res.status).toBe(403);
  });
});
