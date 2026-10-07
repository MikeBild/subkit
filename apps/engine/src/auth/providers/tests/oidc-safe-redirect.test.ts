import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { oidcLoginStates, tenants } from "../../../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../../db/tests/setup.ts";
import { createOidcProvider } from "../oidc.ts";
import { type MockOidcHandle, startMockOidc } from "./fixtures/mock-oidc.ts";

let testDb: TestDb;
let mock: MockOidcHandle;
let _tenantId = "";

const CLIENT_ID = "mock-client-safe-redirect";
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
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  try {
    if (mock) await mock.stop();
  } catch {}
  if (testDb) await testDb.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

function buildProvider() {
  return createOidcProvider({
    db: testDb.db,
    issuerUrl: mock.url,
    clientId: CLIENT_ID,
    clientSecret: "mock-secret",
    redirectUri: REDIRECT_URI,
    enableSignup: true,
  });
}

async function getFinishLoginLocation(redirectToOverride: string | null): Promise<string> {
  const provider = buildProvider();

  const startRes = await provider.startLogin!(
    new Request(`http://127.0.0.1:0/v1/identity/login/start?tenant=oidc-safe-redirect`),
  );
  expect(startRes.status).toBe(302);
  const authorizeUrl = new URL(startRes.headers.get("location") ?? "");
  const state = authorizeUrl.searchParams.get("state") ?? "";
  expect(state.length).toBeGreaterThan(0);

  await fetch(authorizeUrl.toString(), { redirect: "manual" });

  if (redirectToOverride !== null) {
    await testDb.db
      .update(oidcLoginStates)
      .set({ redirect_to: redirectToOverride })
      .where(eq(oidcLoginStates.state, state));
  }

  const issued = mock.issueFor(
    {
      sub: `safe-redirect-sub-${state.slice(0, 8)}`,
      email: `safe-redirect-${state.slice(0, 8)}@test.local`,
    },
    { state, redirect_uri: REDIRECT_URI },
  );

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
    const sameOriginUrl = "http://127.0.0.1:0/v1/oauth/authorize?client_id=abc";
    const location = await getFinishLoginLocation(sameOriginUrl);
    expect(location).toBe(sameOriginUrl);
  });
});
