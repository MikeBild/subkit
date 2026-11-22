import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { browserSessionFromRequest } from "../../../auth/browser-session.ts";
import {
  apiKeys,
  auditLog,
  authIdentities,
  connectors,
  tenants,
  userInvites,
  users,
} from "../../../db/schema/index.ts";
import { issueApiKey } from "../../../identity/service.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import {
  ctx,
  login,
  mock,
  providerId,
  responseCookie,
  setupBrowserMemberships,
} from "../../tests/memberships-fixtures.ts";
import { browserSessionHeaders, createSecondaryTenant } from "../../tests/setup.ts";

setupBrowserMemberships();

type Session = Awaited<ReturnType<typeof login>>;

function browserHeaders(session: Session) {
  return {
    cookie: session.cookie,
    "x-subkit-tenant": session.payload.tenant_id,
    "x-subkit-csrf": session.csrf,
    "content-type": "application/json",
  };
}

async function bootstrap(session: Session) {
  const response = await fetch(`${ctx.baseUrl}/v1/cockpit/bootstrap`, {
    headers: { cookie: session.cookie },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    principal: { id: string; display_name: string | null; is_owner: boolean };
    tenant: { display_name: string; timezone: string; language: string; origin: string };
    start_steps: Record<"hidden" | "connector" | "workflow" | "run" | "people" | "client", boolean>;
  };
}

async function inviteInto(owner: Session, email: string) {
  const response = await fetch(`${ctx.baseUrl}/v1/identity/users`, {
    method: "POST",
    headers: browserHeaders(owner),
    body: JSON.stringify({ email, role: "member", invite: {} }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    id: string;
    status: string;
    invite: { id: string; plaintext_token: string };
  };
}

async function inviteSignIn(token: string, claims: { sub: string; email: string }) {
  const start = await fetch(`${ctx.baseUrl}/v1/identity/invites/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, provider_id: providerId }),
    redirect: "manual",
  });
  expect(start.status).toBe(200);
  const location = ((await start.json()) as { authorization_url: string }).authorization_url;
  expect(location).not.toContain(token);
  const authUrl = new URL(location);
  const issued = mock.issueFor(
    { ...claims, email_verified: true },
    {
      state: authUrl.searchParams.get("state") ?? "",
      redirect_uri: authUrl.searchParams.get("redirect_uri") ?? "",
    },
  );
  await fetch(location, { redirect: "manual" });
  return fetch(issued.callbackUrl, { redirect: "manual", headers: { accept: "text/html" } });
}

describe("workspace settings", () => {
  test("the owner renames the workspace and changes its time zone and language, and deletion asks for the new name", async () => {
    const owner = await login("settings-owner");
    expect(await bootstrap(owner)).toMatchObject({
      principal: { display_name: "Test Owner", is_owner: true },
      tenant: {
        display_name: "Test workspace",
        timezone: "UTC",
        language: "en",
        origin: "self_service",
      },
    });
    const renamed = await fetch(`${ctx.baseUrl}/v1/identity/workspace`, {
      method: "PATCH",
      headers: browserHeaders(owner),
      body: JSON.stringify({
        display_name: "  Harbor Office ",
        timezone: "Europe/Berlin",
        language: "de",
      }),
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({
      id: owner.payload.tenant_id,
      display_name: "Harbor Office",
      timezone: "Europe/Berlin",
      language: "de",
      origin: "self_service",
    });
    expect((await bootstrap(owner)).tenant).toMatchObject({
      display_name: "Harbor Office",
      timezone: "Europe/Berlin",
      language: "de",
    });
    const [entry] = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, owner.payload.tenant_id), eq(auditLog.action, "tenant.updated")),
      );
    expect(entry).toMatchObject({
      actor_type: "user",
      actor_id: owner.payload.user_id,
      resource_type: "tenant",
      resource_id: owner.payload.tenant_id,
      result: "success",
      before: { display_name: "Test workspace", timezone: "UTC", language: "en" },
      after: { display_name: "Harbor Office", timezone: "Europe/Berlin", language: "de" },
    });

    const badLanguage = await fetch(`${ctx.baseUrl}/v1/identity/workspace`, {
      method: "PATCH",
      headers: browserHeaders(owner),
      body: JSON.stringify({ language: "fr" }),
    });
    expect(badLanguage.status).toBe(400);

    const badZone = await fetch(`${ctx.baseUrl}/v1/identity/workspace`, {
      method: "PATCH",
      headers: browserHeaders(owner),
      body: JSON.stringify({ timezone: "Mars/Olympus" }),
    });
    expect(badZone.status).toBe(422);
    expect(await badZone.json()).toMatchObject({ code: "invalid_timezone" });

    const deletion = (confirmation: string) =>
      fetch(`${ctx.baseUrl}/v1/identity/owned-tenant/deletion`, {
        method: "POST",
        headers: browserHeaders(owner),
        body: JSON.stringify({ confirmation }),
      });
    expect((await deletion("Test workspace")).status).toBe(403);
    expect((await deletion("Harbor Office")).status).toBe(200);
  });

  test("the owner keeps the right after losing the administrator role, a member never has it", async () => {
    const owner = await login("settings-demoted-owner");
    await ctx.db
      .update(users)
      .set({ role_id: await builtinRoleId(ctx.db, "member") })
      .where(eq(users.id, owner.payload.user_id));
    const byOwner = await fetch(`${ctx.baseUrl}/v1/identity/workspace`, {
      method: "PATCH",
      headers: browserHeaders(owner),
      body: JSON.stringify({ display_name: "Still mine" }),
    });
    expect(byOwner.status).toBe(200);

    const [member] = await ctx.db
      .insert(users)
      .values({
        tenant_id: owner.payload.tenant_id,
        email: "settings-member@example.test",
        role_id: await builtinRoleId(ctx.db, "member"),
      })
      .returning();
    if (!member) throw new Error("member missing");
    const memberHeaders = await browserSessionHeaders(
      { db: ctx.db, tenantId: owner.payload.tenant_id },
      member.id,
    );
    const byMember = await fetch(`${ctx.baseUrl}/v1/identity/workspace`, {
      method: "PATCH",
      headers: memberHeaders,
      body: JSON.stringify({ display_name: "Not yours" }),
    });
    expect(byMember.status).toBe(403);
    expect(await byMember.json()).toMatchObject({ code: "workspace_admin_required" });
    const [tenant] = await ctx.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, owner.payload.tenant_id));
    expect(tenant?.display_name).toBe("Still mine");
  });

  test("an administrator of a self-hosted workspace changes it with identity:write, a member key does not", async () => {
    const admin = { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" };
    const changed = await fetch(`${ctx.baseUrl}/v1/identity/workspace`, {
      method: "PATCH",
      headers: admin,
      body: JSON.stringify({ display_name: "Self hosted renamed", timezone: "America/New_York" }),
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      id: ctx.tenantId,
      display_name: "Self hosted renamed",
      timezone: "America/New_York",
      origin: "self_hosted",
    });
    const [member] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "self-hosted-member@example.test",
        role_id: await builtinRoleId(ctx.db, "member"),
      })
      .returning();
    if (!member) throw new Error("member missing");
    const key = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: ctx.tenantId,
        owner_kind: "user",
        owner_id: member.id,
        actor_id: null,
      },
      ctx.db,
    );
    const refused = await fetch(`${ctx.baseUrl}/v1/identity/workspace`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${key.plaintext}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Not allowed" }),
    });
    expect(refused.status).toBe(403);
    const other = await createSecondaryTenant(ctx, "settings-other");
    const [untouched] = await ctx.db.select().from(tenants).where(eq(tenants.id, other.tenantId));
    expect(untouched?.display_name).not.toBe("Self hosted renamed");
  });
});

describe("own profile and first steps", () => {
  test("a person edits only their own row and the hidden flag round-trips through bootstrap", async () => {
    const owner = await login("profile-owner");
    const [colleague] = await ctx.db
      .insert(users)
      .values({
        tenant_id: owner.payload.tenant_id,
        email: "profile-colleague@example.test",
        display_name: "Colleague",
        role_id: await builtinRoleId(ctx.db, "member"),
      })
      .returning();
    if (!colleague) throw new Error("colleague missing");
    expect((await bootstrap(owner)).start_steps.hidden).toBe(false);
    const patched = await fetch(`${ctx.baseUrl}/v1/identity/me`, {
      method: "PATCH",
      headers: browserHeaders(owner),
      body: JSON.stringify({ display_name: " Grace Hopper ", start_steps_hidden: true }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({
      id: owner.payload.user_id,
      email: "profile-owner@example.test",
      display_name: "Grace Hopper",
      start_steps_hidden: true,
    });
    const after = await bootstrap(owner);
    expect(after.principal.display_name).toBe("Grace Hopper");
    expect(after.start_steps.hidden).toBe(true);
    const [untouched] = await ctx.db.select().from(users).where(eq(users.id, colleague.id));
    expect(untouched).toMatchObject({ display_name: "Colleague", start_steps_hidden_at: null });

    const shown = await fetch(`${ctx.baseUrl}/v1/identity/me`, {
      method: "PATCH",
      headers: browserHeaders(owner),
      body: JSON.stringify({ start_steps_hidden: false }),
    });
    expect(await shown.json()).toMatchObject({
      display_name: "Grace Hopper",
      start_steps_hidden: false,
    });
    expect((await bootstrap(owner)).start_steps.hidden).toBe(false);
    expect(
      (
        await fetch(`${ctx.baseUrl}/v1/identity/me`, {
          method: "PATCH",
          headers: browserHeaders(owner),
          body: JSON.stringify({ id: colleague.id, display_name: "Hijacked" }),
        })
      ).status,
    ).toBe(400);
    const byKey = await fetch(`${ctx.baseUrl}/v1/identity/me`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Key" }),
    });
    expect(byKey.status).toBe(403);
  });

  test("each first step turns true once the workspace has one", async () => {
    const owner = await login("steps-owner");
    expect((await bootstrap(owner)).start_steps).toEqual({
      hidden: false,
      connector: false,
      workflow: false,
      run: false,
      people: false,
      client: false,
    });
    await ctx.db.insert(connectors).values({
      tenant_id: owner.payload.tenant_id,
      slug: "steps-connector",
      display_name: "Steps connector",
      driver: "http",
    });
    await inviteInto(owner, "steps-colleague@example.test");
    await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: owner.payload.tenant_id,
        owner_kind: "user",
        owner_id: owner.payload.user_id,
        actor_id: null,
      },
      ctx.db,
    );
    const other = await login("steps-other-owner");
    expect((await bootstrap(owner)).start_steps).toMatchObject({
      connector: true,
      workflow: false,
      run: false,
      people: true,
      client: true,
    });
    expect((await bootstrap(other)).start_steps).toMatchObject({
      connector: false,
      people: false,
      client: false,
    });
    await ctx.db
      .update(apiKeys)
      .set({ revoked_at: new Date(0) })
      .where(eq(apiKeys.tenant_id, owner.payload.tenant_id));
    expect((await bootstrap(owner)).start_steps.client).toBe(false);
  });
});

describe("invitations into a hosted workspace complete in the browser", () => {
  test("a person who is not signed in joins the inviting workspace through the sign-in provider", async () => {
    const owner = await login("invite-owner");
    await fetch(`${ctx.baseUrl}/v1/identity/me`, {
      method: "PATCH",
      headers: browserHeaders(owner),
      body: JSON.stringify({ display_name: "Olive Owner" }),
    });
    const invited = await inviteInto(owner, "invite-joiner@example.test");
    expect(invited.status).toBe("invited");

    const preview = await fetch(`${ctx.baseUrl}/v1/identity/invites/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: invited.invite.plaintext_token }),
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      workspace_name: "Test workspace",
      invited_by_name: "Olive Owner",
      email_hint: "i•••@example.test",
      providers: [{ id: providerId, label: "Hosted" }],
    });

    const cli = await fetch(`${ctx.baseUrl}/v1/identity/invites/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: invited.invite.plaintext_token }),
    });
    expect(cli.status).toBe(400);
    expect(await cli.json()).toMatchObject({ code: "invite_browser_required" });

    const finished = await inviteSignIn(invited.invite.plaintext_token, {
      sub: "invite-joiner",
      email: "invite-joiner@example.test",
    });
    expect(finished.status).toBe(302);
    expect(finished.headers.get("location")).toBe("/cockpit/invite?joined=1");
    const cookie = responseCookie(finished, "subkit_session");
    if (!cookie) throw new Error("session cookie missing");
    const payload = await browserSessionFromRequest(
      new Request(ctx.baseUrl, { headers: { cookie } }),
    );
    expect(payload?.tenant_id).toBe(owner.payload.tenant_id);
    expect(payload?.user_id).toBe(invited.id);
    const [member] = await ctx.db.select().from(users).where(eq(users.id, invited.id));
    expect(member?.status).toBe("active");
    expect(member?.auth_identity_id).not.toBeNull();
    const [invite] = await ctx.db
      .select()
      .from(userInvites)
      .where(eq(userInvites.id, invited.invite.id));
    expect(invite?.redeemed_at).not.toBeNull();
    expect(
      await ctx.db
        .select()
        .from(tenants)
        .where(eq(tenants.owner_identity_id, member?.auth_identity_id ?? "")),
    ).toHaveLength(0);
    expect((await login("invite-joiner")).payload.tenant_id).toBe(owner.payload.tenant_id);
  });

  test("a different verified address is turned away and nothing changes", async () => {
    const owner = await login("mismatch-owner");
    const invited = await inviteInto(owner, "mismatch-invited@example.test");
    const tenantsBefore = (await ctx.db.select({ id: tenants.id }).from(tenants)).length;
    const finished = await inviteSignIn(invited.invite.plaintext_token, {
      sub: "mismatch-stranger",
      email: "mismatch-stranger@example.test",
    });
    expect(finished.status).toBe(302);
    expect(finished.headers.get("location")).toBe("/cockpit/invite?error=identity_mismatch");
    expect(responseCookie(finished, "subkit_session")).toBeNull();
    expect(responseCookie(finished, "subkit_identity_registration")).toBeNull();
    const [member] = await ctx.db.select().from(users).where(eq(users.id, invited.id));
    expect(member).toMatchObject({ status: "invited", auth_identity_id: null });
    const [invite] = await ctx.db
      .select()
      .from(userInvites)
      .where(eq(userInvites.id, invited.invite.id));
    expect(invite?.redeemed_at).toBeNull();
    expect(
      await ctx.db
        .select()
        .from(authIdentities)
        .where(eq(authIdentities.subject, "mismatch-stranger")),
    ).toHaveLength(0);
    expect((await ctx.db.select({ id: tenants.id }).from(tenants)).length).toBe(tenantsBefore);
  });

  test("a withdrawn or expired link sends a browser back to the invitation page with the reason", async () => {
    const owner = await login("unavailable-owner");
    const expired = await inviteInto(owner, "unavailable-expired@example.test");
    await ctx.db
      .update(userInvites)
      .set({ expires_at: new Date(0) })
      .where(eq(userInvites.id, expired.invite.id));
    const revoked = await inviteInto(owner, "unavailable-revoked@example.test");
    await ctx.db
      .update(userInvites)
      .set({ revoked_at: new Date(0) })
      .where(eq(userInvites.id, revoked.invite.id));
    for (const token of [expired.invite.plaintext_token, revoked.invite.plaintext_token]) {
      const json = await fetch(`${ctx.baseUrl}/v1/identity/invites/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, provider_id: providerId }),
        redirect: "manual",
      });
      expect(json.status).toBe(403);
      expect(await json.json()).toMatchObject({ message: "invite_unavailable" });
    }
    const previews = await Promise.all(
      [expired, revoked].map(async (entry) =>
        (
          await fetch(`${ctx.baseUrl}/v1/identity/invites/preview`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: entry.invite.plaintext_token }),
          })
        ).json(),
      ),
    );
    expect(previews.map((body) => (body as { code: string }).code)).toEqual([
      "invite_expired",
      "invite_revoked",
    ]);
  });

  test("a signed-in member of another workspace claims the invitation and switches over", async () => {
    const owner = await login("claim-owner");
    const visitor = await login("claim-visitor");
    const invited = await inviteInto(owner, "claim-visitor@example.test");
    const claimed = await fetch(`${ctx.baseUrl}/v1/identity/invites/claim`, {
      method: "POST",
      headers: browserHeaders(visitor),
      body: JSON.stringify({ token: invited.invite.plaintext_token }),
    });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({
      tenant_id: owner.payload.tenant_id,
      user_id: invited.id,
      claimed: true,
    });
    const [member] = await ctx.db.select().from(users).where(eq(users.id, invited.id));
    expect(member?.status).toBe("active");
  });

  test("an invited person who uses the normal sign-in reaches the welcome page, not the inviting workspace", async () => {
    const owner = await login("ignored-owner");
    const invited = await inviteInto(owner, "ignored-invitee@example.test");
    const visitor = await login("ignored-invitee");
    expect(visitor.payload.tenant_id).not.toBe(owner.payload.tenant_id);
    const [member] = await ctx.db.select().from(users).where(eq(users.id, invited.id));
    expect(member).toMatchObject({ status: "invited", auth_identity_id: null });
  });
});
