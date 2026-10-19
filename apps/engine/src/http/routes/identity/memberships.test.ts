import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  browserSessionFromRequest,
  signBrowserCsrf,
  signBrowserSession,
  verifyBrowserSession,
} from "../../../auth/browser-session.ts";
import { createOidcProvider } from "../../../auth/providers/oidc.ts";
import {
  type MockOidcHandle,
  startMockOidc,
} from "../../../auth/providers/tests/fixtures/mock-oidc.ts";
import { setConfigKey } from "../../../config/loader.ts";
import { sessions, tenants, users } from "../../../db/schema/index.ts";
import { createInvite, createUser, provisionSelfServiceTenant } from "../../../identity/index.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { configureHostedPolicyForTests } from "../../../test-helpers/hosted-policy.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

const uuid = createDeterministicUuidFactory(811);

let ctx: HttpTestServer;
let mock: MockOidcHandle;
const providerId = "hosted-browser";

beforeAll(async () => {
  ctx = await createHttpTestServer("browser-memberships");
  await configureHostedPolicyForTests(ctx.db, ctx.testDb.url);
  mock = await startMockOidc();
  await setConfigKey("server.public_base_url", ctx.baseUrl);
  await setConfigKey("auth.hosted.enabled", true);
  await setConfigKey("llm.hosted.enabled", true);
  await setConfigKey("llm.hosted.tenant_monthly_microunits", "1000000");
  await setConfigKey("llm.hosted.global_monthly_microunits", "10000000");
  await setConfigKey("llm.hosted.models", [
    {
      model: "anthropic:billing-model",
      max_context_tokens: 1000,
      max_output_tokens: 100,
      input_usd_per_million_tokens: "3",
      output_usd_per_million_tokens: "15",
      cache_read_usd_per_million_tokens: "0.3",
      cache_write_5m_usd_per_million_tokens: "3.75",
      cache_write_1h_usd_per_million_tokens: "6",
    },
  ]);
  await setConfigKey("storage.hosted.retained_rows_per_resource", 1000);
  await setConfigKey("storage.hosted.tenant_bytes", "1000000");
  await setConfigKey("storage.hosted.max_file_bytes", "100000");
  await setConfigKey("server.hosted_rate_limit.peer_per_minute", 1000);
  await setConfigKey("server.hosted_rate_limit.principal_per_minute", 1000);
  await setConfigKey("server.hosted_rate_limit.tenant_per_month", 10000);
  await setConfigKey("server.hosted_rate_limit.tenant_per_minute", 1000);
  await setConfigKey("server.hosted_rate_limit.global_per_minute", 1000);
  await setConfigKey("queue.hosted.execution_concurrency", 1);
  await setConfigKey("queue.hosted.chat_concurrency", 1);
  await setConfigKey("queue.hosted.pending_jobs", 10);
  await setConfigKey("auth.hosted.registration_enabled", true);
  await setConfigKey("auth.enable_signup", false);
  await setConfigKey("auth.providers", [
    {
      protocol: "oidc",
      id: providerId,
      label: "Hosted",
      issuer_url: mock.url,
      client_id: "mock-client",
      signup_policy: "self_service",
    },
  ]);
});
afterAll(async () => {
  if (mock) await mock.stop();
  if (ctx) await ctx.cleanup();
});

function provider() {
  return createOidcProvider({
    db: ctx.db,
    providerId,
    redirectUri: `${ctx.baseUrl}/v1/identity/login/callback`,
  });
}
async function beginLogin(subject: string, verified = true) {
  const adapter = provider();
  const start = await adapter.startLogin?.(
    new Request(`${ctx.baseUrl}/login?tenant=arbitrary-tenant&redirect_to=/cockpit`),
  );
  if (!start) throw new Error("start missing");
  expect(start.status).toBe(302);
  const location = start.headers.get("location");
  if (!location) throw new Error("authorize location missing");
  const authUrl = new URL(location);
  const state = authUrl.searchParams.get("state");
  if (!state) throw new Error("state missing");
  const issued = mock.issueFor(
    { sub: subject, email: `${subject}@example.test`, email_verified: verified },
    { state, redirect_uri: `${ctx.baseUrl}/v1/identity/login/callback` },
  );
  await fetch(location, { redirect: "manual" });
  return { adapter, callback: issued.callbackUrl };
}
async function login(subject: string) {
  const pending = await beginLogin(subject);
  const response = await pending.adapter.finishLogin?.(new Request(pending.callback));
  if (!response) throw new Error("callback missing");
  expect(response.status).toBe(302);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("session cookie missing");
  const payload = await browserSessionFromRequest(
    new Request(ctx.baseUrl, { headers: { cookie } }),
  );
  if (!payload) throw new Error("session payload missing");
  return { cookie, payload, csrf: await signBrowserCsrf(payload) };
}

describe("hosted browser identity and memberships", () => {
  test("hosted callback resolves a new own tenant without a tenant hint or global signup flag", async () => {
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
      const response = await pending.adapter.finishLogin?.(new Request(pending.callback));
      expect(response?.status).toBe(403);
      expect(await response?.json()).toMatchObject({ code: "registration_closed" });
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
      const cookie = finish?.headers.get("set-cookie");
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
