import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { signBrowserSession, verifyBrowserSession } from "../../../auth/browser-session.ts";
import { sessions, users } from "../../../db/schema/index.ts";
import { browserMembershipIdentity, provisionSelfServiceTenant } from "../../../identity/index.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import {
  ctx,
  login,
  mock,
  setupBrowserMemberships,
  uuid,
} from "../../tests/memberships-fixtures.ts";

setupBrowserMemberships();

describe("hosted browser identity and memberships", () => {
  test("tenant switch rotates cookie and CSRF, preserves expiry, and refuses stale reads and writes", async () => {
    const owner = await login("switch-owner");
    const destination = await provisionSelfServiceTenant(
      {
        issuer_url: mock.url,
        subject: "destination-owner",
        email: "destination@example.test",
        email_verified: true,
      },
      ctx.db,
    );
    const [source] = await ctx.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.tenant_id, owner.payload.tenant_id),
          eq(sessions.id, owner.payload.session_id),
        ),
      );
    if (!source?.auth_identity_id) throw new Error("OIDC proof missing");
    await ctx.db.insert(users).values({
      tenant_id: destination.tenant.id,
      auth_identity_id: source.auth_identity_id,
      email: "switch-owner@example.test",
      role_id: await builtinRoleId(ctx.db, "member"),
    });
    const request = {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "x-subkit-csrf": owner.csrf,
      },
      body: JSON.stringify({ tenant_id: destination.tenant.id }),
    };
    const response = await fetch(`${ctx.baseUrl}/v1/identity/tenant-session`, request);
    expect(response.status).toBe(200);
    const nextCookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!nextCookie) throw new Error("new cookie missing");
    const nextPayload = await verifyBrowserSession(nextCookie.slice("subkit_session=".length));
    if (!nextPayload) throw new Error("new payload missing");
    expect(nextPayload.tenant_id).toBe(destination.tenant.id);
    expect(nextPayload.session_id).not.toBe(source.id);
    const [next] = await ctx.db
      .select()
      .from(sessions)
      .where(
        and(eq(sessions.tenant_id, destination.tenant.id), eq(sessions.id, nextPayload.session_id)),
      );
    expect(next?.absolute_expires_at).toEqual(source.absolute_expires_at);
    expect((await fetch(`${ctx.baseUrl}/v1/identity/tenant-session`, request)).status).not.toBe(
      200,
    );
    const staleRead = await fetch(`${ctx.baseUrl}/v1/identity/whoami`, {
      headers: { cookie: nextCookie, "x-subkit-tenant": owner.payload.tenant_id },
    });
    expect(staleRead.status).toBe(409);
    const freshRead = await fetch(`${ctx.baseUrl}/v1/identity/whoami`, {
      headers: { cookie: nextCookie, "x-subkit-tenant": destination.tenant.id },
    });
    expect(freshRead.status).toBe(200);
    const missingFile = `fid_${uuid()}`;
    const mediaUrl = `${ctx.baseUrl}/v1/files/${missingFile}/content`;
    expect(
      (
        await fetch(`${mediaUrl}?tenant_context=${destination.tenant.id}`, {
          headers: { cookie: nextCookie },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${mediaUrl}?tenant_context=${owner.payload.tenant_id}`, {
          headers: { cookie: nextCookie },
        })
      ).status,
    ).toBe(409);
    const staleWrite = await fetch(`${ctx.baseUrl}/v1/identity/tenant-session`, {
      ...request,
      headers: { ...request.headers, cookie: nextCookie },
    });
    expect(staleWrite.status).toBe(403);
  });

  test("memberships and tenant switch accept exactly the browser sessions the session provider accepts", async () => {
    const owner = await login("sliding-switch-owner");
    const destination = await provisionSelfServiceTenant(
      {
        issuer_url: mock.url,
        subject: "sliding-destination-owner",
        email: "sliding-destination@example.test",
        email_verified: true,
      },
      ctx.db,
    );
    const sessionWhere = (payload: typeof owner.payload) =>
      and(eq(sessions.tenant_id, payload.tenant_id), eq(sessions.id, payload.session_id));
    const [source] = await ctx.db.select().from(sessions).where(sessionWhere(owner.payload));
    if (!source?.auth_identity_id) throw new Error("OIDC proof missing");
    await ctx.db.insert(users).values({
      tenant_id: destination.tenant.id,
      auth_identity_id: source.auth_identity_id,
      email: "sliding-switch-owner@example.test",
      role_id: await builtinRoleId(ctx.db, "member"),
    });
    await ctx.db
      .update(sessions)
      .set({
        expires_at: new Date(getTestNow() - 60 * 60_000),
        last_seen_at: new Date(getTestNow() - 60 * 60_000),
      })
      .where(sessionWhere(owner.payload));
    expect(
      (
        await fetch(`${ctx.baseUrl}/v1/identity/whoami`, {
          headers: { cookie: owner.cookie, "x-subkit-tenant": owner.payload.tenant_id },
        })
      ).status,
    ).toBe(200);
    expect(
      (await fetch(`${ctx.baseUrl}/v1/identity/memberships`, { headers: { cookie: owner.cookie } }))
        .status,
    ).toBe(200);
    const switched = await fetch(`${ctx.baseUrl}/v1/identity/tenant-session`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "x-subkit-csrf": owner.csrf,
      },
      body: JSON.stringify({ tenant_id: destination.tenant.id }),
    });
    expect(switched.status).toBe(200);

    const rejected = [
      { revoked_at: new Date(getTestNow() - 60_000) },
      {
        absolute_expires_at: new Date(getTestNow() - 60_000),
        last_seen_at: new Date(getTestNow() - 60_000),
      },
      { last_seen_at: new Date(getTestNow() - 9 * 60 * 60_000) },
    ];
    for (const [index, change] of rejected.entries()) {
      const denied = await login(`sliding-denied-owner-${index}`);
      await ctx.db.update(sessions).set(change).where(sessionWhere(denied.payload));
      await expect(browserMembershipIdentity(denied.payload, ctx.db)).rejects.toThrow(
        "membership_unavailable",
      );
      expect(
        (
          await fetch(`${ctx.baseUrl}/v1/identity/memberships`, {
            headers: { cookie: denied.cookie },
          })
        ).status,
      ).not.toBe(200);
      expect(
        (
          await fetch(`${ctx.baseUrl}/v1/identity/tenant-session`, {
            method: "POST",
            headers: {
              cookie: denied.cookie,
              "content-type": "application/json",
              "x-subkit-csrf": denied.csrf,
            },
            body: JSON.stringify({ tenant_id: destination.tenant.id }),
          })
        ).status,
      ).not.toBe(200);
    }
  });

  test("a validly signed cookie cannot substitute another user for a session", async () => {
    const owner = await login("forged-user-proof");
    const forged = await signBrowserSession({ ...owner.payload, user_id: ctx.userId });
    const response = await fetch(`${ctx.baseUrl}/v1/identity/memberships`, {
      headers: { cookie: `subkit_session=${forged}` },
    });
    expect(response.status).toBe(403);
  });

  test("unrelated or removed memberships cannot receive a new session", async () => {
    const owner = await login("restricted-owner");
    const target = await login("unrelated-owner");
    const response = await fetch(`${ctx.baseUrl}/v1/identity/tenant-session`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "x-subkit-csrf": owner.csrf,
      },
      body: JSON.stringify({ tenant_id: target.payload.tenant_id }),
    });
    expect(response.status).toBe(403);
    await ctx.db
      .update(users)
      .set({ status: "disabled" })
      .where(
        and(eq(users.tenant_id, owner.payload.tenant_id), eq(users.id, owner.payload.user_id)),
      );
    expect(
      (await fetch(`${ctx.baseUrl}/v1/identity/memberships`, { headers: { cookie: owner.cookie } }))
        .status,
    ).not.toBe(200);
  });
});
