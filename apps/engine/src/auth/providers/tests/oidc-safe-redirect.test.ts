// Integration tests for isSafeRedirect, driven through finishLogin.
//
// isSafeRedirect is module-local to oidc.ts — we exercise it via the
// observable finishLogin response Location header. The pattern mirrors
// oidc-real.test.ts: startLogin creates the oidcLoginStates row, then we
// UPDATE redirect_to directly in the test DB, then call finishLogin and
// inspect the response.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { oidcLoginStates, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { createOidcProvider } from "../oidc.ts";
import { type MockOidcHandle, startMockOidc } from "./fixtures/mock-oidc.ts";

let testDb: TestDb;
let mock: MockOidcHandle;
let _tenantId = "";

const CLIENT_ID = "mock-client-safe-redirect";
// The redirect_uri registered with the mock OIDC provider. isSafeRedirect uses
// this as the base URL for same-origin checks.
const REDIRECT_URI = "http://127.0.0.1:0/v1/identity/login/callback";

beforeAll(async () => {
  testDb = await createTestDb("oidc-safe-redirect");
  mock = await startMockOidc();

  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "oidc-safe-redirect", display_name: "OIDC Safe Redirect" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  _tenantId = t.id;
}, 30_000);

afterAll(async () => {
  try {
    await mock.stop();
  } catch {
    /* ignore */
  }
  if (testDb) await testDb.cleanup();
}, 30_000);

function buildProvider() {
  return createOidcProvider({
    db: testDb.db,
    issuerUrl: mock.url,
    clientId: CLIENT_ID,
    clientSecret: "mock-secret",
    redirectUri: REDIRECT_URI,
    // Each case logs in with a fresh subject; the signup gate itself is
    // covered in oidc-real.test.ts.
    enableSignup: true,
  });
}

/**
 * Run the startLogin → authorize → (override redirect_to) → finishLogin
 * pipeline and return the Location header from finishLogin.
 */
async function getFinishLoginLocation(redirectToOverride: string | null): Promise<string> {
  const provider = buildProvider();

  // 1. Start login — creates the oidcLoginStates row
  const startRes = await provider.startLogin!(
    new Request(`http://127.0.0.1:0/v1/identity/login/start?tenant=oidc-safe-redirect`),
  );
  expect(startRes.status).toBe(302);
  const authorizeUrl = new URL(startRes.headers.get("location") ?? "");
  const state = authorizeUrl.searchParams.get("state") ?? "";
  expect(state.length).toBeGreaterThan(0);

  // 2. Hit the mock /authorize so it stashes the nonce
  await fetch(authorizeUrl.toString(), { redirect: "manual" });

  // 3. Override redirect_to in the DB row
  if (redirectToOverride !== null) {
    await testDb.db
      .update(oidcLoginStates)
      .set({ redirect_to: redirectToOverride })
      .where(eq(oidcLoginStates.state, state));
  }

  // 4. Stage mock claims and get callback URL
  const issued = mock.issueFor(
    {
      sub: `safe-redirect-sub-${state.slice(0, 8)}`,
      email: `safe-redirect-${state.slice(0, 8)}@test.local`,
    },
    { state, redirect_uri: REDIRECT_URI },
  );

  // 5. Drive finishLogin
  const finishRes = await provider.finishLogin!(new Request(issued.callbackUrl));
  expect(finishRes.status).toBe(302);
  return finishRes.headers.get("location") ?? "";
}

describe("isSafeRedirect via finishLogin Location header", () => {
  test("external URL https://attacker.example.com/steal → Location is /", async () => {
    const location = await getFinishLoginLocation("https://attacker.example.com/steal");
    expect(location).toBe("/");
  });

  test("protocol-relative //attacker.example.com → Location is /", async () => {
    const location = await getFinishLoginLocation("//attacker.example.com");
    expect(location).toBe("/");
  });

  test("path-only /v1/oauth/authorize?client_id=x → Location is that path", async () => {
    const path = "/v1/oauth/authorize?client_id=x";
    const location = await getFinishLoginLocation(path);
    expect(location).toBe(path);
  });

  test("same-origin absolute URL → Location is that URL", async () => {
    // REDIRECT_URI is http://127.0.0.1:0/v1/identity/login/callback
    // The same-origin target must share the origin: http://127.0.0.1:0
    const sameOriginUrl = "http://127.0.0.1:0/v1/oauth/authorize?client_id=abc";
    const location = await getFinishLoginLocation(sameOriginUrl);
    expect(location).toBe(sameOriginUrl);
  });
});
