import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { setConfigKey } from "../../config/loader.ts";
import { apiKeys, httpRateLimitBuckets } from "../../db/schema/index.ts";
import { provisionSelfServiceTenant } from "../../identity/index.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let fixture: HttpTestServer;
beforeAll(async () => {
  fixture = await createHttpTestServer("hosted-request-limits");
  await configureHostedPolicyForTests(fixture.db, fixture.testDb.url);
  const own = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: "rate-owner",
      email: "rate-owner@example.test",
      email_verified: true,
    },
    fixture.db,
  );
  const tenantKey = and(eq(apiKeys.tenant_id, fixture.tenantId), eq(apiKeys.id, fixture.apiKeyId));
  const [key] = await fixture.db.select().from(apiKeys).where(tenantKey);
  if (!key) throw new Error("fixture API key missing");
  await fixture.db.delete(apiKeys).where(tenantKey);
  await fixture.db
    .insert(apiKeys)
    .values({ ...key, tenant_id: own.tenant.id, user_id: own.membership.user_id });
});
beforeEach(async () => {
  await fixture.db.delete(httpRateLimitBuckets);
  await setConfigKey("auth.hosted.enabled", false);
  await setConfigKey("server.hosted_rate_limit.tenant_per_month", 10000);
  await setConfigKey("server.hosted_rate_limit.peer_per_minute", 10);
  await setConfigKey("server.hosted_rate_limit.principal_per_minute", 10);
  await setConfigKey("server.hosted_rate_limit.tenant_per_minute", 10);
  await setConfigKey("server.hosted_rate_limit.global_per_minute", 10);
});
afterAll(async () => {
  await fixture?.cleanup();
});
const request = (authenticated = true, headers: Record<string, string> = {}) =>
  fetch(`${fixture.baseUrl}/v1/identity/whoami`, {
    headers: {
      ...(authenticated ? { authorization: `Bearer ${fixture.apiKey}` } : {}),
      ...headers,
    },
  });

test("unauthorized attempts consume ingress capacity before authentication and ignore forged forwarding", async () => {
  await setConfigKey("server.hosted_rate_limit.peer_per_minute", 1);
  await setConfigKey("auth.hosted.enabled", true);
  expect((await request(false)).status).toBe(401);
  const denied = await request(false, {
    "x-forwarded-for": "198.51.100.4",
    "x-real-ip": "198.51.100.5",
  });
  expect(denied.status).toBe(429);
  expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(Number(denied.headers.get("retry-after"))).toBeLessThanOrEqual(60);
});

test("existing hosted API keys remain tenant-limited with service flags disabled", async () => {
  await setConfigKey("server.hosted_rate_limit.tenant_per_minute", 1);
  expect((await request()).status).toBe(200);
  expect((await request()).status).toBe(429);
});

test("missing hosted request policy fails closed for an existing hosted tenant", async () => {
  await setConfigKey("server.hosted_rate_limit.tenant_per_minute", 0);
  expect((await request()).status).toBe(503);
});

test("authenticated requests consume the global ingress ceiling exactly once", async () => {
  await setConfigKey("server.hosted_rate_limit.global_per_minute", 2);
  await setConfigKey("auth.hosted.enabled", true);
  expect((await request()).status).toBe(200);
  expect((await request()).status).toBe(200);
  expect((await request()).status).toBe(429);
});

test("principal limits remain separate from a shared tenant allowance", async () => {
  await setConfigKey("server.hosted_rate_limit.principal_per_minute", 1);
  expect((await request()).status).toBe(200);
  expect((await request()).status).toBe(429);
});

test("non-API paths remain outside hosted request admission", async () => {
  await setConfigKey("server.hosted_rate_limit.tenant_per_minute", 0);
  const response = await fetch(`${fixture.baseUrl}/not-a-product-api-path`, {
    headers: { authorization: `Bearer ${fixture.apiKey}` },
  });
  expect(response.status).toBe(404);
});

test("monthly exhaustion has a distinct refusal while account membership checks remain available", async () => {
  await setConfigKey("server.hosted_rate_limit.tenant_per_month", 1);
  expect((await request()).status).toBe(200);
  const denied = await request();
  expect(denied.status).toBe(429);
  expect(await denied.json()).toMatchObject({ code: "request_quota_exhausted" });
  expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
  const membership = await fetch(`${fixture.baseUrl}/v1/identity/memberships`, {
    headers: { authorization: `Bearer ${fixture.apiKey}` },
  });
  expect(membership.status).toBe(403);
});
