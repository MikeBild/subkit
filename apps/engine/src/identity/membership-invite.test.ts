import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../auth/browser-session.ts";
import { getConfig, setConfigKey } from "../config/loader.ts";
import {
  auditLog,
  sessions,
  tenants,
  userIdentities,
  userInvites,
  users,
} from "../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../test-helpers/workspace-registration.ts";
import {
  acceptVerifiedMembershipInvite,
  createInvite,
  createInvitedUser,
  createUser,
  deactivateUser,
  previewMembershipInvite,
  provisionSelfServiceTenant,
} from "./index.ts";

let ctx: HttpTestServer;
const issuer = "https://identity.example.test";
beforeAll(async () => {
  ctx = await createHttpTestServer("membership-admission");
  await configureHostedPolicyForTests(ctx.db, ctx.testDb.url);
  for (const key of Object.keys(getConfig().server.hosted_rate_limit))
    await setConfigKey(`server.hosted_rate_limit.${key}`, 10000);
});
afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

async function actor(subject: string) {
  const provisioned = await provisionSelfServiceTenant(
    { issuer_url: issuer, subject, email: `${subject}@example.test`, email_verified: true },
    TEST_WORKSPACE_REGISTRATION,
    ctx.db,
  );
  const [session] = await ctx.db
    .insert(sessions)
    .values({
      tenant_id: provisioned.tenant.id,
      user_id: provisioned.membership.user_id,
      auth_identity_id: provisioned.identity.id,
      expires_at: new Date(getTestNow() + 60_000),
      absolute_expires_at: new Date(getTestNow() + 60_000),
      last_seen_at: new Date(getTestNow()),
    })
    .returning();
  if (!session) throw new Error("session missing");
  const payload = {
    tenant_id: session.tenant_id,
    user_id: session.user_id,
    session_id: session.id,
  };
  return {
    provisioned,
    headers: {
      cookie: browserSessionCookie(await signBrowserSession(payload)),
      "content-type": "application/json",
      "x-subkit-csrf": await signBrowserCsrf(payload),
      "x-subkit-tenant": session.tenant_id,
    },
  };
}
async function invite(subject: string, scopes = ["*"]) {
  const destination = await provisionSelfServiceTenant(
    {
      issuer_url: issuer,
      subject: `owner-${subject}`,
      email: `owner-${subject}@example.test`,
      email_verified: true,
    },
    TEST_WORKSPACE_REGISTRATION,
    ctx.db,
  );
  const user = await createUser(
    {
      tenant_id: destination.tenant.id,
      email: `${subject}@example.test`,
      role: "member",
      status: "invited",
      actor_id: null,
      actor_kind: "system",
    },
    ctx.db,
  );
  const invitation = await createInvite(
    {
      issuer: { kind: "system" },
      tenant_id: destination.tenant.id,
      user_id: user.id,
      scopes,
      actor_id: null,
      actor_kind: "system",
    },
    ctx.db,
  );
  return { destination, user, invitation };
}
async function claim(headers: Record<string, string>, token: string) {
  return fetch(`${ctx.baseUrl}/v1/identity/invites/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({ token }),
  });
}

test("verified browser invitation claim is atomic, replay-safe and creates no credential", async () => {
  const authenticated = await actor("invited-person");
  const fixture = await invite("invited-person");
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => claim(authenticated.headers, fixture.invitation.plaintext)),
  );
  expect(responses.every((response) => response.status === 200)).toBe(true);
  const bodies = await Promise.all(
    responses.map((response) => response.json() as Promise<{ claimed: boolean }>),
  );
  expect(bodies.filter((body) => body.claimed)).toHaveLength(1);
  const [member] = await ctx.db
    .select()
    .from(users)
    .where(and(eq(users.id, fixture.user.id), eq(users.tenant_id, fixture.destination.tenant.id)));
  expect(member?.auth_identity_id).toBe(authenticated.provisioned.identity.id);
  expect(member?.status).toBe("active");
  const redeemed = await fetch(`${ctx.baseUrl}/v1/identity/invites/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: fixture.invitation.plaintext }),
  });
  expect(redeemed.status).toBe(400);
});

test("invite audience, CSRF, scopes and suspended destinations fail closed", async () => {
  const authenticated = await actor("intended-person");
  const other = await actor("other-person");
  const fixture = await invite("intended-person");
  expect((await claim(other.headers, fixture.invitation.plaintext)).status).toBe(403);
  expect(
    (
      await claim(
        { ...authenticated.headers, "x-subkit-csrf": "wrong" },
        fixture.invitation.plaintext,
      )
    ).status,
  ).toBe(403);
  await ctx.db
    .update(tenants)
    .set({ status: "suspended" })
    .where(eq(tenants.id, fixture.destination.tenant.id));
  expect((await claim(authenticated.headers, fixture.invitation.plaintext)).status).toBe(403);
  await ctx.db
    .update(tenants)
    .set({ status: "active" })
    .where(eq(tenants.id, fixture.destination.tenant.id));
  await ctx.db
    .update(users)
    .set({ email: "previous-invite@example.test" })
    .where(and(eq(users.tenant_id, fixture.destination.tenant.id), eq(users.id, fixture.user.id)));
  const limited = await invite("intended-person", ["knowledge:read"]);
  expect((await claim(authenticated.headers, limited.invitation.plaintext)).status).toBe(403);
  const [unchanged] = await ctx.db
    .select()
    .from(userInvites)
    .where(
      and(
        eq(userInvites.id, limited.invitation.view.id),
        eq(userInvites.tenant_id, limited.destination.tenant.id),
      ),
    );
  expect(unchanged?.redeemed_at).toBeNull();
});

function verified(subject: string) {
  return {
    issuer_url: issuer,
    subject,
    email: `${subject}@example.test`,
    email_verified: true as const,
  };
}

function person(fixture: Awaited<ReturnType<typeof invite>>) {
  return and(eq(users.id, fixture.user.id), eq(users.tenant_id, fixture.destination.tenant.id));
}

test("an invitation for a person who is active but never signed in is open and can be accepted", async () => {
  const authenticated = await actor("earlier-claim");
  const claimable = await invite("earlier-claim");
  await ctx.db.update(users).set({ status: "active" }).where(person(claimable));
  expect(await previewMembershipInvite(claimable.invitation.plaintext, ctx.db)).toMatchObject({
    ok: true,
  });
  const claimed = await claim(authenticated.headers, claimable.invitation.plaintext);
  expect(claimed.status).toBe(200);
  expect(await claimed.json()).toMatchObject({ claimed: true });
  const [member] = await ctx.db.select().from(users).where(person(claimable));
  expect(member?.auth_identity_id).toBe(authenticated.provisioned.identity.id);

  const signedIn = await invite("earlier-oidc");
  await ctx.db.update(users).set({ status: "active" }).where(person(signedIn));
  const stranger = acceptVerifiedMembershipInvite(
    verified("earlier-stranger"),
    signedIn.invitation.view.id,
    ctx.db,
  );
  await expect(stranger).rejects.toMatchObject({ code: "invite_identity_mismatch" });
  const accepted = await acceptVerifiedMembershipInvite(
    verified("earlier-oidc"),
    signedIn.invitation.view.id,
    ctx.db,
  );
  expect(accepted.membership.user_id).toBe(signedIn.user.id);

  const disabled = await invite("earlier-disabled");
  await ctx.db.update(users).set({ status: "disabled" }).where(person(disabled));
  expect(await previewMembershipInvite(disabled.invitation.plaintext, ctx.db)).toEqual({
    ok: false,
    code: "invite_unavailable",
  });
  const refused = acceptVerifiedMembershipInvite(
    verified("earlier-disabled"),
    disabled.invitation.view.id,
    ctx.db,
  );
  await expect(refused).rejects.toMatchObject({ code: "invite_identity_mismatch" });
});

test("withdrawing an invitation nobody accepted removes the person, so the address can be invited again", async () => {
  const fixture = await invite("withdrawn-person");
  const tenantId = fixture.destination.tenant.id;
  const withdrawn = await deactivateUser(
    { tenant_id: tenantId, user_id: fixture.user.id, actor_id: null, actor_kind: "system" },
    ctx.db,
  );
  expect(withdrawn?.id).toBe(fixture.user.id);
  expect(await ctx.db.select().from(users).where(person(fixture))).toHaveLength(0);
  expect(
    await ctx.db
      .select()
      .from(userInvites)
      .where(and(eq(userInvites.tenant_id, tenantId), eq(userInvites.user_id, fixture.user.id))),
  ).toHaveLength(0);
  expect(await previewMembershipInvite(fixture.invitation.plaintext, ctx.db)).toEqual({
    ok: false,
    code: "invite_invalid",
  });
  const audited = await ctx.db
    .select({ action: auditLog.action, reason: auditLog.reason })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.reason, "invitation_withdrawn")));
  expect(audited.map((row) => row.action).sort()).toEqual(["user.deleted", "user_invite.revoked"]);

  const again = await createInvitedUser(
    {
      issuer: { kind: "system" },
      tenant_id: tenantId,
      email: "withdrawn-person@example.test",
      role: "member",
      actor_id: null,
      actor_kind: "system",
    },
    ctx.db,
  );
  expect(again.user.status).toBe("invited");
  expect(again.user.id).not.toBe(fixture.user.id);

  const authenticated = await actor("joined-person");
  const joined = await invite("joined-person");
  expect((await claim(authenticated.headers, joined.invitation.plaintext)).status).toBe(200);
  await deactivateUser(
    {
      tenant_id: joined.destination.tenant.id,
      user_id: joined.user.id,
      actor_id: null,
      actor_kind: "system",
    },
    ctx.db,
  );
  const [kept] = await ctx.db.select().from(users).where(person(joined));
  expect(kept?.status).toBe("disabled");
  expect(kept?.deleted_at).not.toBeNull();
});

test("accepting an invitation waits for the person's row without holding the invitation", async () => {
  const fixture = await invite("lock-order");
  const holder = await ctx.testDb.pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM subkit.users WHERE id = $1 FOR UPDATE", [fixture.user.id]);
    const accepting = acceptVerifiedMembershipInvite(
      verified("lock-order"),
      fixture.invitation.view.id,
      ctx.db,
    );
    accepting.catch(() => {});
    await waitFor(
      async () => {
        const waiting = await ctx.db.execute<{ waiting: number }>(
          sql`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        return (waiting.rows[0]?.waiting ?? 0) > 0;
      },
      { tries: 200, sleepMs: 25, label: "accept waits for the person's row" },
    );
    await holder.query("SELECT id FROM subkit.user_invites WHERE id = $1 FOR UPDATE NOWAIT", [
      fixture.invitation.view.id,
    ]);
    await holder.query("COMMIT");
    expect((await accepting).membership.user_id).toBe(fixture.user.id);
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    holder.release();
  }
});

test("operator identity migration requires an exact reviewed report and never merges email", async () => {
  const subject = "existing-identity";
  const tenantId = ctx.tenantId;
  const user = await createUser(
    {
      tenant_id: tenantId,
      email: "migration@example.test",
      role: "member",
      actor_id: ctx.userId,
      actor_kind: "user",
    },
    ctx.db,
  );
  await ctx.db.insert(userIdentities).values({
    tenant_id: tenantId,
    user_id: user.id,
    provider_id: "old-browser",
    issuer_url: issuer,
    subject,
    email: user.email,
  });
  const headers = { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" };
  const url = `${ctx.baseUrl}/v1/identity/provider-identities/migration`;
  const preview = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ issuer_url: issuer, subject }),
  });
  expect(preview.status).toBe(200);
  const report = (await preview.json()) as {
    digest: string;
    applied: boolean;
    conflicts: string[];
  };
  expect(report.applied).toBe(false);
  expect(report.conflicts).toEqual([]);
  await ctx.db
    .update(users)
    .set({ role_id: await builtinRoleId(ctx.db, "admin") })
    .where(and(eq(users.tenant_id, tenantId), eq(users.id, user.id)));
  expect(
    (
      await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ issuer_url: issuer, subject, reviewed_digest: report.digest }),
      })
    ).status,
  ).toBe(409);
  const refreshed = (await (
    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ issuer_url: issuer, subject }),
    })
  ).json()) as { digest: string };
  const applied = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ issuer_url: issuer, subject, reviewed_digest: refreshed.digest }),
  });
  expect(applied.status).toBe(200);
  expect(((await applied.json()) as { applied: boolean }).applied).toBe(true);
  const [linked] = await ctx.db
    .select()
    .from(users)
    .where(and(eq(users.tenant_id, tenantId), eq(users.id, user.id)));
  expect(linked?.auth_identity_id).not.toBeNull();
});
