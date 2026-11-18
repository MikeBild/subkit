import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { browserSessionFromRequest, signBrowserSession } from "../../../auth/browser-session.ts";
import { setConfigKey } from "../../../config/loader.ts";
import { authIdentities, sessions, tenants, users } from "../../../db/schema/index.ts";
import { createInvite, createUser, provisionSelfServiceTenant } from "../../../identity/index.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../../../test-helpers/workspace-registration.ts";
import {
  beginLogin,
  ctx,
  login,
  mock,
  provider,
  providerId,
  responseCookie,
  setupBrowserMemberships,
} from "../../tests/memberships-fixtures.ts";

setupBrowserMemberships();

describe("hosted browser identity and memberships", () => {
  test("a returning owner signs in to the workspace created at onboarding without a tenant hint", async () => {
    const first = await login("hosted-owner");
    const second = await login("hosted-owner");
    expect(first.payload.tenant_id).toBe(second.payload.tenant_id);
    const response = await fetch(`${ctx.baseUrl}/v1/identity/memberships`, {
      headers: { cookie: second.cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ tenant_id: string; is_owner: boolean }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.tenant_id).toBe(first.payload.tenant_id);
    expect(body.items[0]?.is_owner).toBe(true);
  });

  test("closed registration keeps existing identities available and blocks new own tenants", async () => {
    const existing = await login("existing-when-closed");
    await setConfigKey("auth.hosted.registration_enabled", false);
    try {
      expect((await login("existing-when-closed")).payload.tenant_id).toBe(
        existing.payload.tenant_id,
      );
      const pending = await beginLogin("new-when-closed");
      const response = await pending.adapter.finishLogin?.(
        new Request(pending.callback, { headers: { accept: "application/json" } }),
      );
      expect(response?.status).toBe(403);
      expect(await response?.json()).toMatchObject({ code: "registration_closed" });
      const browserPending = await beginLogin("new-when-closed-browser");
      const browserResponse = await browserPending.adapter.finishLogin?.(
        new Request(browserPending.callback, {
          headers: { accept: "text/html", "accept-language": "de" },
        }),
      );
      expect(browserResponse?.status).toBe(403);
      expect(browserResponse?.headers.get("content-type")).toContain("text/html");
      const html = await browserResponse?.text();
      expect(html).toContain("Nur auf Einladung");
      expect(html).toContain("Einladungslink");
      expect(
        browserResponse?.headers
          .getSetCookie()
          .some((value) => value.startsWith("subkit_identity_registration=")),
      ).toBe(false);
      expect(
        await ctx.db
          .select()
          .from(authIdentities)
          .where(eq(authIdentities.subject, "new-when-closed-browser")),
      ).toHaveLength(0);
      expect(html).toContain('data-testid="auth-retry"');
      expect(html).not.toContain('"code":"registration_closed"');
    } finally {
      await setConfigKey("auth.hosted.registration_enabled", true);
    }
  });

  test("a new invited identity can sign in while registration is closed without an own tenant", async () => {
    const destination = await provisionSelfServiceTenant(
      {
        issuer_url: mock.url,
        subject: "invite-destination",
        email: "invite-destination@example.test",
        email_verified: true,
      },
      TEST_WORKSPACE_REGISTRATION,
      ctx.db,
    );
    const user = await createUser(
      {
        tenant_id: destination.tenant.id,
        email: "new-invited@example.test",
        status: "invited",
        role: "member",
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
        actor_id: null,
        actor_kind: "system",
      },
      ctx.db,
    );
    await setConfigKey("auth.hosted.registration_enabled", false);
    try {
      const start = await fetch(`${ctx.baseUrl}/v1/identity/invites/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: invitation.plaintext, provider_id: providerId }),
        redirect: "manual",
      });
      expect(start.status).toBe(302);
      const location = start.headers.get("location");
      if (!location) throw new Error("invite redirect missing");
      expect(location).not.toContain(invitation.plaintext);
      const authUrl = new URL(location);
      const state = authUrl.searchParams.get("state");
      const redirectUri = authUrl.searchParams.get("redirect_uri");
      if (!state || !redirectUri) throw new Error("OIDC parameters missing");
      const issued = mock.issueFor(
        { sub: "new-invited", email: "new-invited@example.test", email_verified: true },
        { state, redirect_uri: redirectUri },
      );
      await fetch(location, { redirect: "manual" });
      const finish = await provider().finishLogin?.(new Request(issued.callbackUrl));
      expect(finish?.status).toBe(302);
      expect(finish?.headers.get("location")).toBe("/cockpit/invite?joined=1");
      const cookie = finish ? responseCookie(finish, "subkit_session") : null;
      if (!cookie) throw new Error("invited session missing");
      const payload = await browserSessionFromRequest(
        new Request(ctx.baseUrl, { headers: { cookie } }),
      );
      expect(payload?.tenant_id).toBe(destination.tenant.id);
      const [member] = await ctx.db
        .select()
        .from(users)
        .where(and(eq(users.tenant_id, destination.tenant.id), eq(users.id, user.id)));
      expect(member?.auth_identity_id).not.toBeNull();
      if (!member?.auth_identity_id) throw new Error("membership identity missing");
      expect(
        await ctx.db
          .select()
          .from(tenants)
          .where(eq(tenants.owner_identity_id, member.auth_identity_id)),
      ).toHaveLength(0);
      const subsequent = await login("new-invited");
      expect(subsequent.payload.tenant_id).toBe(destination.tenant.id);
    } finally {
      await setConfigKey("auth.hosted.registration_enabled", true);
    }
  });

  test("verified OIDC sign-in for a deleted-pending owner issues recovery proof without tenant authority", async () => {
    const owner = await login("oidc-recovery-owner");
    const ownedResponse = await fetch(`${ctx.baseUrl}/v1/identity/owned-tenant`, {
      headers: { cookie: owner.cookie, "x-subkit-tenant": owner.payload.tenant_id },
    });
    expect(ownedResponse.status).toBe(200);
    const ownedState = (await ownedResponse.json()) as { tenant: { display_name: string } };
    const deletionHeaders = {
      cookie: owner.cookie,
      "x-subkit-tenant": owner.payload.tenant_id,
      "x-subkit-csrf": owner.csrf,
      "content-type": "application/json",
    };
    expect(
      (
        await fetch(`${ctx.baseUrl}/v1/identity/owned-tenant/deletion`, {
          method: "POST",
          headers: deletionHeaders,
          body: JSON.stringify({ confirmation: "wrong confirmation" }),
        })
      ).status,
    ).toBe(403);
    const deletion = await fetch(`${ctx.baseUrl}/v1/identity/owned-tenant/deletion`, {
      method: "POST",
      headers: deletionHeaders,
      body: JSON.stringify({ confirmation: ownedState.tenant.display_name }),
    });
    expect(deletion.status).toBe(200);
    const pending = await beginLogin("oidc-recovery-owner");
    const response = await pending.adapter.finishLogin?.(new Request(pending.callback));
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toContain("/cockpit/recovery?");
    const reauth = await fetch(`${ctx.baseUrl}/v1/identity/recovery/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_id: providerId }),
    });
    expect(reauth.status).toBe(200);
    const { authorization_url: authLocation } = (await reauth.json()) as {
      authorization_url: string;
    };
    const authUrl = new URL(authLocation);
    expect(authUrl.searchParams.get("prompt")).toBe("login");
    expect(authUrl.searchParams.get("max_age")).toBe("0");
    const issued = mock.issueFor(
      {
        sub: "oidc-recovery-owner",
        email: "oidc-recovery-owner@example.test",
        email_verified: true,
        auth_time: Math.floor(getTestNow() / 1000),
      },
      {
        state: authUrl.searchParams.get("state") ?? "",
        redirect_uri: authUrl.searchParams.get("redirect_uri") ?? "",
      },
    );
    await fetch(authLocation, { redirect: "manual" });
    const loginCookie = reauth.headers
      .getSetCookie()
      .find((value) => value.startsWith("subkit_recovery_login="))
      ?.split(";")[0];
    if (!loginCookie) throw new Error("recovery browser binding cookie missing");
    const recovered = await provider().finishLogin?.(
      new Request(issued.callbackUrl, { headers: { cookie: loginCookie } }),
    );
    const cookie = recovered?.headers
      .getSetCookie()
      .find((value) => value.startsWith("subkit_identity_recovery="))
      ?.split(";")[0];
    if (!cookie) throw new Error("fresh OIDC recovery proof missing");
    const state = await fetch(`${ctx.baseUrl}/v1/identity/recovery`, { headers: { cookie } });
    expect(state.status).toBe(200);
    const recoveryState = (await state.json()) as {
      tenant: { id: string };
      can_restore: boolean;
      csrf_token: string;
    };
    expect(recoveryState).toMatchObject({
      tenant: { id: owner.payload.tenant_id },
      can_restore: true,
    });
    expect(
      (await fetch(`${ctx.baseUrl}/v1/identity/memberships`, { headers: { cookie } })).status,
    ).toBe(401);
    const restore = await fetch(`${ctx.baseUrl}/v1/identity/owned-tenant/restore`, {
      method: "POST",
      headers: { cookie, "x-subkit-recovery-csrf": recoveryState.csrf_token },
    });
    expect(restore.status).toBe(200);
    expect(
      (
        await fetch(`${ctx.baseUrl}/v1/identity/owned-tenant/restore`, {
          method: "POST",
          headers: { cookie, "x-subkit-recovery-csrf": recoveryState.csrf_token },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(`${ctx.baseUrl}/v1/identity/memberships`, { headers: { cookie: owner.cookie } }))
        .status,
    ).not.toBe(200);
    expect((await login("oidc-recovery-owner")).payload.tenant_id).toBe(owner.payload.tenant_id);
  });

  test("recovery rejects cross-site start, missing browser binding and stale or missing authentication time", async () => {
    expect(
      (
        await fetch(`${ctx.baseUrl}/v1/identity/recovery/login`, {
          method: "POST",
          headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
          body: JSON.stringify({ provider_id: providerId }),
        })
      ).status,
    ).toBe(403);
    await login("negative-recovery-owner");
    for (const scenario of ["missing-cookie", "stale-auth", "missing-auth", "unknown-identity"]) {
      const start = await fetch(`${ctx.baseUrl}/v1/identity/recovery/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider_id: providerId }),
      });
      expect(start.status).toBe(200);
      const { authorization_url } = (await start.json()) as { authorization_url: string };
      const url = new URL(authorization_url);
      const issued = mock.issueFor(
        {
          sub:
            scenario === "unknown-identity"
              ? "no-such-recovery-identity"
              : "negative-recovery-owner",
          email: "negative-recovery-owner@example.test",
          email_verified: true,
          ...(scenario === "missing-auth"
            ? {}
            : {
                auth_time: Math.floor(getTestNow() / 1000) - (scenario === "stale-auth" ? 600 : 0),
              }),
        },
        {
          state: url.searchParams.get("state") ?? "",
          redirect_uri: url.searchParams.get("redirect_uri") ?? "",
        },
      );
      await fetch(authorization_url, { redirect: "manual" });
      const cookie = start.headers
        .getSetCookie()
        .find((value) => value.startsWith("subkit_recovery_login="))
        ?.split(";")[0];
      const callback = await provider().finishLogin?.(
        new Request(issued.callbackUrl, {
          headers: scenario === "missing-cookie" ? {} : { cookie: cookie ?? "" },
        }),
      );
      expect(callback?.status).toBe(403);
      expect(
        callback?.headers
          .getSetCookie()
          .some((value) => value.startsWith("subkit_identity_recovery=")),
      ).toBe(false);
    }
  });

  test("unverified email and disabled hosted callbacks fail closed", async () => {
    const pending = await beginLogin("unverified-browser", false);
    expect((await pending.adapter.finishLogin?.(new Request(pending.callback)))?.status).toBe(403);
    const disabled = await beginLogin("disabled-browser");
    await setConfigKey("auth.hosted.registration_enabled", false);
    await setConfigKey("auth.hosted.enabled", false);
    expect((await disabled.adapter.finishLogin?.(new Request(disabled.callback)))?.status).toBe(
      403,
    );
    expect((await provider().startLogin?.(new Request(`${ctx.baseUrl}/login`)))?.status).toBe(403);
    await setConfigKey("auth.hosted.enabled", true);
    await setConfigKey("auth.hosted.registration_enabled", true);
  });

  test("API keys and API-key browser sessions cannot gain global memberships", async () => {
    const api = await fetch(`${ctx.baseUrl}/v1/identity/memberships`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(api.status).toBe(403);
    const owner = await login("key-laundering");
    const [session] = await ctx.db
      .insert(sessions)
      .values({
        tenant_id: owner.payload.tenant_id,
        user_id: owner.payload.user_id,
        expires_at: new Date(getTestNow() + 60_000),
        absolute_expires_at: new Date(getTestNow() + 60_000),
        last_seen_at: new Date(getTestNow()),
      })
      .returning();
    if (!session) throw new Error("session missing");
    const token = await signBrowserSession({ ...owner.payload, session_id: session.id });
    const cookie = `subkit_session=${token}`;
    expect(
      (await fetch(`${ctx.baseUrl}/v1/identity/memberships`, { headers: { cookie } })).status,
    ).toBe(403);
  });
});
