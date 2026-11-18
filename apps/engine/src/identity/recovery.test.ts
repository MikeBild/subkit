import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { browserSessionFromRequest } from "../auth/browser-session.ts";
import { createBrowserSessionProvider } from "../auth/providers/browser-session.ts";
import { identityRecoverySessions, tenants } from "../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../test-helpers/workspace-registration.ts";
import {
  consumeIdentityRecovery,
  identityRecoveryFromRequest,
  issueIdentityRecovery,
  readIdentityRecovery,
} from "./recovery.ts";
import { provisionSelfServiceTenant } from "./self-service.ts";

let ctx: HttpTestServer;
beforeAll(async () => {
  ctx = await createHttpTestServer("identity-recovery");
  await configureHostedPolicyForTests(ctx.db, ctx.testDb.url);
});
afterAll(async () => {
  if (ctx) await ctx.cleanup();
});
async function recovery(subject: string) {
  const claims = {
    issuer_url: "https://identity.example.test",
    subject,
    email: `${subject}@example.test`,
    email_verified: true as const,
  };
  const owned = await provisionSelfServiceTenant(claims, TEST_WORKSPACE_REGISTRATION, ctx.db);
  await ctx.db
    .update(tenants)
    .set({
      status: "pending_deletion",
      deletion_requested_at: new Date(getTestNow()),
      deletion_scheduled_for: new Date(getTestNow() + 7 * 86_400_000),
    })
    .where(eq(tenants.id, owned.tenant.id));
  const response = await issueIdentityRecovery(claims, ctx.db);
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("subkit_identity_recovery="))
    ?.split(";")[0];
  if (!cookie) throw new Error("recovery cookie missing");
  return {
    owned,
    response,
    cookie,
    request: new Request(`${ctx.baseUrl}/v1/identity/recovery`, { headers: { cookie } }),
  };
}

test("recovery proves a fresh global identity without authenticating a tenant session", async () => {
  const fixture = await recovery("recover-owner");
  expect(fixture.response.status).toBe(302);
  expect(
    fixture.response.headers
      .getSetCookie()
      .some((value) => value.startsWith("subkit_session=;") && value.includes("Max-Age=0")),
  ).toBe(true);
  expect(await browserSessionFromRequest(fixture.request)).toBeNull();
  expect(await createBrowserSessionProvider({ db: ctx.db }).resolve(fixture.request)).toBeNull();
  const response = await fetch(`${ctx.baseUrl}/v1/identity/recovery`, {
    headers: { cookie: fixture.cookie },
  });
  expect(response.status).toBe(200);
  const state = (await response.json()) as {
    tenant: { id: string };
    can_restore: boolean;
    csrf_token: string;
    expires_at: string;
  };
  expect(state.tenant.id).toBe(fixture.owned.tenant.id);
  expect(state.can_restore).toBe(true);
  expect(state.csrf_token).toBeTruthy();
  expect(new Date(state.expires_at).getTime() - getTestNow()).toBeLessThanOrEqual(300_000);
  expect(
    (
      await fetch(`${ctx.baseUrl}/v1/identity/recovery`, {
        headers: { authorization: `Bearer ${ctx.apiKey}` },
      })
    ).status,
  ).toBe(403);
});

test("recovery action is CSRF-bound, one-time and transactionally rolled back on failure", async () => {
  const fixture = await recovery("atomic-recovery");
  const state = await readIdentityRecovery(fixture.request, ctx.db);
  await expect(
    consumeIdentityRecovery(fixture.request, async () => "unsafe", ctx.db),
  ).rejects.toThrow("recovery_csrf_rejected");
  const request = new Request(fixture.request, {
    method: "POST",
    headers: { cookie: fixture.cookie, "x-subkit-recovery-csrf": state.csrf_token },
  });
  await expect(
    consumeIdentityRecovery(
      request,
      async () => {
        throw new Error("domain failure");
      },
      ctx.db,
    ),
  ).rejects.toThrow("domain failure");
  expect((await identityRecoveryFromRequest(fixture.request, ctx.db)).identity_id).toBe(
    fixture.owned.identity.id,
  );
  const outcomes = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      consumeIdentityRecovery(
        request,
        async (identityId, tx) => {
          expect(identityId).toBe(fixture.owned.identity.id);
          await tx
            .update(tenants)
            .set({ status: "active", deletion_requested_at: null, deletion_scheduled_for: null })
            .where(eq(tenants.id, fixture.owned.tenant.id));
          return "restored";
        },
        ctx.db,
      ),
    ),
  );
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  await expect(identityRecoveryFromRequest(fixture.request, ctx.db)).rejects.toThrow(
    "recovery_unavailable",
  );
});

test("expired or cross-site recovery cannot restore a tenant", async () => {
  const fixture = await recovery("expired-recovery");
  const state = await readIdentityRecovery(fixture.request, ctx.db);
  const crossSite = new Request(fixture.request, {
    method: "POST",
    headers: {
      cookie: fixture.cookie,
      "x-subkit-recovery-csrf": state.csrf_token,
      "sec-fetch-site": "cross-site",
    },
  });
  await expect(consumeIdentityRecovery(crossSite, async () => "unsafe", ctx.db)).rejects.toThrow(
    "recovery_csrf_rejected",
  );
  const proof = await identityRecoveryFromRequest(fixture.request, ctx.db);
  await ctx.db
    .update(identityRecoverySessions)
    .set({ expires_at: new Date(getTestNow() - 1000) })
    .where(eq(identityRecoverySessions.id, proof.recovery_id));
  await expect(identityRecoveryFromRequest(fixture.request, ctx.db)).rejects.toThrow(
    "recovery_unavailable",
  );
});
