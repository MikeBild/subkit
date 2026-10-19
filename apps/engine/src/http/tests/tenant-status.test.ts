import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { browserSessionFromRequest, issueBrowserSession } from "../../auth/browser-session.ts";
import { setConfigKey } from "../../config/loader.ts";
import { sessions, tenants } from "../../db/schema/index.ts";
import { provisionSelfServiceTenant, requestOwnedTenantDeletion } from "../../identity/index.ts";
import { resolveStdioPrincipal } from "../../mcp/auth.ts";
import { withActiveTenantJobContext } from "../../queue/job-context.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let fixture: HttpTestServer;

beforeAll(async () => {
  fixture = await createHttpTestServer("tenant-status");
});

afterEach(async () => {
  await fixture.db
    .update(tenants)
    .set({ status: "active" })
    .where(eq(tenants.id, fixture.tenantId));
});

afterAll(async () => {
  await fixture?.cleanup();
});

test("an existing API key is refused immediately when its tenant is suspended", async () => {
  const headers = { authorization: `Bearer ${fixture.apiKey}` };
  expect((await fetch(`${fixture.baseUrl}/v1/identity/whoami`, { headers })).status).toBe(200);
  await fixture.db
    .update(tenants)
    .set({ status: "suspended" })
    .where(eq(tenants.id, fixture.tenantId));
  const denied = await fetch(`${fixture.baseUrl}/v1/identity/whoami`, { headers });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ code: "tenant_unavailable" });
});

async function ownedBrowserFixture(label: string) {
  await configureHostedPolicyForTests(fixture.db, fixture.testDb.url);
  for (const dimension of ["peer", "principal", "tenant", "global"])
    await setConfigKey(`server.hosted_rate_limit.${dimension}_per_minute`, 1000);
  await setConfigKey("server.hosted_rate_limit.tenant_per_month", 10000);
  const owned = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: label,
      email: `${label}@example.test`,
      email_verified: true,
    },
    fixture.db,
  );
  const issued = await issueBrowserSession({
    db: fixture.db,
    tenantId: owned.tenant.id,
    userId: owned.membership.user_id,
    authIdentityId: owned.identity.id,
    redirectTo: "/cockpit",
    via: "test",
  });
  const cookie = issued.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("browser session fixture missing");
  const headers = { cookie, "x-subkit-tenant": owned.tenant.id };
  const proof = await browserSessionFromRequest(new Request(fixture.baseUrl, { headers }));
  if (!proof) throw new Error("verified browser session fixture missing");
  expect((await fetch(`${fixture.baseUrl}/v1/identity/whoami`, { headers })).status).toBe(200);
  return { owned, proof, headers };
}

test("a real deletion revokes the previously issued owner browser session", async () => {
  const { owned, proof, headers } = await ownedBrowserFixture("deleted-browser-owner");
  await requestOwnedTenantDeletion(
    { ...proof, confirmation: owned.tenant.display_name },
    fixture.db,
  );
  const [pending] = await fixture.db
    .select({
      status: tenants.status,
      requested: tenants.deletion_requested_at,
      scheduled: tenants.deletion_scheduled_for,
    })
    .from(tenants)
    .where(eq(tenants.id, owned.tenant.id));
  expect(pending?.status).toBe("pending_deletion");
  if (!pending?.requested || !pending.scheduled)
    throw new Error("deletion deadline fixture missing");
  expect(pending.scheduled.getTime() - pending.requested.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  expect((await fetch(`${fixture.baseUrl}/v1/identity/whoami`, { headers })).status).toBe(401);
});

test("a non-revoked browser session is refused by the pending tenant status guard", async () => {
  const { owned, proof, headers } = await ownedBrowserFixture("pending-browser-guard");
  const requested = new Date(getTestNow());
  await fixture.db
    .update(tenants)
    .set({
      status: "pending_deletion",
      deletion_requested_at: requested,
      deletion_scheduled_for: new Date(requested.getTime() + 7 * 24 * 60 * 60 * 1000),
    })
    .where(eq(tenants.id, owned.tenant.id));
  const [before] = await fixture.db
    .select({ revoked_at: sessions.revoked_at })
    .from(sessions)
    .where(and(eq(sessions.id, proof.session_id), eq(sessions.tenant_id, owned.tenant.id)));
  expect(before).toEqual({ revoked_at: null });
  const refused = await fetch(`${fixture.baseUrl}/v1/identity/whoami`, { headers });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "tenant_unavailable" });
});

test("stdio principal resolution rechecks tenant status on every authentication", async () => {
  expect(await resolveStdioPrincipal(fixture.db, fixture.apiKey)).toMatchObject({
    tenant_id: fixture.tenantId,
  });
  await fixture.db
    .update(tenants)
    .set({ status: "suspended" })
    .where(eq(tenants.id, fixture.tenantId));
  expect(await resolveStdioPrincipal(fixture.db, fixture.apiKey)).toBeNull();
});

test("a queued job rechecks tenant state before its handler runs", async () => {
  let calls = 0;
  const run = () => {
    calls += 1;
  };
  const data = { tenant_id: fixture.tenantId };
  await withActiveTenantJobContext(data, fixture.db, run);
  expect(calls).toBe(1);
  await fixture.db
    .update(tenants)
    .set({ status: "suspended" })
    .where(eq(tenants.id, fixture.tenantId));
  await expect(withActiveTenantJobContext(data, fixture.db, run)).rejects.toThrow(
    "tenant_unavailable",
  );
  expect(calls).toBe(1);
});

test("a tenant job without a valid tenant cannot bypass the guard", async () => {
  let ran = false;
  await expect(
    withActiveTenantJobContext({}, fixture.db, () => {
      ran = true;
    }),
  ).rejects.toThrow();
  expect(ran).toBe(false);
});
