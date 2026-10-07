import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { loadConfig, setConfigKey } from "../../../config/loader.ts";
import { sessions, tenants, userIdentities, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import type { AppEnv } from "../../../http/openapi.ts";
import { registerLoginRoutes } from "../../../http/routes/identity/login.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { signLoginState } from "../../index.ts";
import { createBrowserSessionProvider } from "../browser-session.ts";
import { createOidcProvider } from "../oidc.ts";
import { type MockOidcHandle, startMockOidc } from "./fixtures/mock-oidc.ts";

let testDb: TestDb;
let mock: MockOidcHandle;
let tenantId: string;
let configDir: string;
let app: OpenAPIHono<AppEnv>;
const baseUrl = "http://localhost:3000";
const callbackUrl = `${baseUrl}/v1/identity/login/callback`;

beforeAll(async () => {
  testDb = await createTestDb("oidc-provider-selection");
  mock = await startMockOidc();
  configDir = mkdtempSync(join(tmpdir(), "subkit-oidc-selection-"));
  await loadConfig({
    env: { DATABASE_URL: testDb.url, NODE_ENV: "test", LLM_PROVIDER: "mock" },
    configPathOverride: join(configDir, "subkit.config.json"),
  });
  await setConfigKey("server.public_base_url", baseUrl);
  await setConfigKey("auth.enable_signup", true);
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "oidc-selection", display_name: "OIDC selection" })
    .returning();
  if (!tenant) throw new Error("tenant seed failed");
  tenantId = tenant.id;
  app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", testDb.db);
    await next();
  });
  registerLoginRoutes(app);
}, 120_000);

afterAll(async () => {
  if (mock) await mock.stop();
  if (testDb) await testDb.cleanup();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}, 120_000);

async function configure(secondProduct?: string) {
  const common = {
    protocol: "oidc",
    issuer_url: mock.url,
    client_id: "mock-client",
    scopes: "openid profile email",
    tenant_slug: "oidc-selection",
  };
  await setConfigKey("auth.providers", [
    { ...common, id: "first", label: "First", product_id: "first-product" },
    {
      ...common,
      id: "second",
      label: "Second",
      ...(secondProduct ? { product_id: secondProduct } : {}),
    },
  ]);
}

async function login(providerId: string, subject: string, expectedProduct: string | null) {
  if (expectedProduct) {
    const [owner] = await testDb.db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: `${subject}@example.test`,
        role_id: await builtinRoleId(testDb.db, "member"),
      })
      .returning();
    if (!owner) throw new Error("owner seed failed");
    await testDb.db.insert(userIdentities).values({
      tenant_id: tenantId,
      user_id: owner.id,
      provider_id: providerId,
      subject,
      email: owner.email,
      issuer_url: mock.url,
      product_id: expectedProduct,
    });
  }
  const state = await signLoginState({ redirect_to: "/cockpit" });
  const start = await app.request(
    `${baseUrl}/v1/identity/login/start?provider=${providerId}&login_state=${encodeURIComponent(state)}`,
  );
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location") ?? "");
  const oidcState = authorize.searchParams.get("state") ?? "";
  expect(oidcState.startsWith(`${providerId}.`)).toBe(true);
  await fetch(authorize, { redirect: "manual" });
  const issued = mock.issueFor(
    { sub: subject, email: `${subject}@example.test` },
    { state: oidcState, redirect_uri: callbackUrl },
  );
  const finish = await app.request(issued.callbackUrl);
  expect(finish.status).toBe(302);
  const cookie = finish.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toBeDefined();
  const principal = await createBrowserSessionProvider({ db: testDb.db }).resolve(
    new Request(`${baseUrl}/v1/executions`, { headers: { cookie: cookie ?? "" } }),
  );
  expect(principal).not.toBeNull();
  expect(principal?.product_id ?? null).toBe(expectedProduct);
  const [session] = await testDb.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenant_id, tenantId), eq(sessions.id, principal?.session_id ?? "")));
  expect(session?.product_id).toBe(expectedProduct);
}

test("the first selected provider keeps its authenticated product", async () => {
  await configure();
  await login("first", "first-owner", "first-product");
});

test("an unbound second provider does not inherit the first provider product", async () => {
  await configure();
  await login("second", "generic-owner", null);
});

test("a differently bound second provider carries only its own product", async () => {
  await configure("second-product");
  await login("second", "second-owner", "second-product");
});

test("an unknown named provider never falls back to the first provider", async () => {
  await configure();
  const provider = createOidcProvider({ db: testDb.db, providerId: "missing" });
  const response = await provider.startLogin?.(
    new Request(`${baseUrl}/v1/identity/login/start`, { headers: { accept: "application/json" } }),
  );
  expect(response?.status).toBe(500);
});
