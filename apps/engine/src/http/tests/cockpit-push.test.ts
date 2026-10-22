import { afterAll, beforeAll, expect, test } from "bun:test";
import { createECDH, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import { cockpitPushSubscriptions } from "../../db/schema/cockpit-push.ts";
import { sessions, users } from "../../db/schema/identity.ts";
import { endCockpitPushForSessions } from "../../identity/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { resolveCockpitPushContext } from "../middleware/cockpit-installation.ts";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

let server: HttpTestServer;
beforeAll(async () => {
  server = await createHttpTestServer("cockpit-push-http");
});
afterAll(async () => {
  if (server) await server.cleanup();
});

test("push opt-in is scoped to the current app session and retains CSRF and key validation", async () => {
  const root = await browserSessionHeaders(server, server.userId);
  const created = await fetch(`${server.baseUrl}/v1/cockpit/installations`, {
    method: "POST",
    headers: root,
    body: "{}",
  });
  expect(created.status).toBe(200);
  const { id } = (await created.json()) as { id: string };
  const base = `${server.baseUrl}/cockpit/i/${id}/api/v1`;
  const cookie = created.headers.get("set-cookie") ?? "";
  const boot = await fetch(`${base}/cockpit/bootstrap`, { headers: { cookie } });
  expect(boot.status).toBe(200);
  const { csrf_token } = (await boot.json()) as { csrf_token: string };
  const headers = { cookie, "x-subkit-csrf": csrf_token, "content-type": "application/json" };
  const denied = await fetch(`${base}/cockpit/push-subscription/prepare`, {
    method: "POST",
    headers: { cookie },
    body: "{}",
  });
  expect(denied.status).toBe(403);
  const rootOnInstallation = await fetch(`${base}/cockpit/push-subscription/prepare`, {
    method: "POST",
    headers: root,
    body: "{}",
  });
  expect(rootOnInstallation.status).toBe(401);
  const prepared = await fetch(`${base}/cockpit/push-subscription/prepare`, {
    method: "POST",
    headers,
    body: "{}",
  });
  expect(prepared.status).toBe(200);
  expect(((await prepared.json()) as { public_key: string }).public_key).toMatch(
    /^[A-Za-z0-9_-]{87}$/,
  );
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from("1".padStart(64, "0"), "hex"));
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/isolated-fixture",
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: Buffer.alloc(16, 7).toString("base64url"),
    },
  };
  const invalid = await fetch(`${base}/cockpit/push-subscription`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      ...subscription,
      keys: { ...subscription.keys, p256dh: "a".repeat(64) },
    }),
  });
  expect(invalid.status).toBe(400);
  const stored = await fetch(`${base}/cockpit/push-subscription`, {
    method: "PUT",
    headers,
    body: JSON.stringify(subscription),
  });
  expect(stored.status).toBe(204);
  const active = await fetch(`${base}/cockpit/push-subscription`, { headers });
  expect(await active.json()).toEqual({ subscribed: true, handled_by_app: false });
  const removed = await fetch(`${base}/cockpit/push-subscription`, { method: "DELETE", headers });
  expect(removed.status).toBe(204);
  const inactive = await fetch(`${base}/cockpit/push-subscription`, { headers });
  expect(await inactive.json()).toEqual({ subscribed: false, handled_by_app: false });
});

async function addUser(): Promise<string> {
  const [user] = await server.db
    .insert(users)
    .values({
      tenant_id: server.tenantId,
      email: `root-push-${randomUUID()}@test.local`, // allow-random
      role_id: await builtinRoleId(server.db, "member"),
    })
    .returning({ id: users.id });
  if (!user) throw new Error("missing root push user");
  return user.id;
}

async function rootSession(
  userId: string,
  input: { lastSeenAt?: Date; expiresAt?: Date; absoluteExpiresAt?: Date; revokedAt?: Date } = {},
) {
  const [session] = await server.db
    .insert(sessions)
    .values({
      tenant_id: server.tenantId,
      user_id: userId,
      expires_at: input.expiresAt ?? new Date(Date.now() + 60 * 60_000), // allow-wall-clock: live browser fixture
      absolute_expires_at: input.absoluteExpiresAt ?? new Date(Date.now() + 60 * 60_000), // allow-wall-clock: live browser fixture
      last_seen_at: input.lastSeenAt ?? null,
      revoked_at: input.revokedAt ?? null,
    })
    .returning({ id: sessions.id });
  if (!session) throw new Error("missing root push session");
  const payload = { tenant_id: server.tenantId, user_id: userId, session_id: session.id };
  return {
    sessionId: session.id,
    headers: {
      cookie: browserSessionCookie(await signBrowserSession(payload)),
      "x-subkit-csrf": await signBrowserCsrf(payload),
      "content-type": "application/json",
    },
  };
}

function rootSubscription(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from("2".padStart(64, "0"), "hex"));
  return {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: Buffer.alloc(16, 5).toString("base64url"),
    },
  };
}

async function rootRows(sessionUserId: string) {
  return await server.db
    .select({
      tenant_id: cockpitPushSubscriptions.tenant_id,
      kind: cockpitPushSubscriptions.kind,
      installation_id: cockpitPushSubscriptions.installation_id,
    })
    .from(cockpitPushSubscriptions)
    .where(
      and(
        eq(cockpitPushSubscriptions.tenant_id, server.tenantId),
        eq(cockpitPushSubscriptions.user_id, sessionUserId),
      ),
    );
}

test("the root Cockpit tab opts in with its own browser session and CSRF", async () => {
  const { headers } = await rootSession(server.userId);
  const base = `${server.baseUrl}/v1/cockpit/push-subscription`;
  const status = await fetch(base, { headers });
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({ subscribed: false, handled_by_app: false });
  const prepared = await fetch(`${base}/prepare`, { method: "POST", headers, body: "{}" });
  expect(prepared.status).toBe(200);
  const subscription = rootSubscription("https://fcm.googleapis.com/fcm/send/root-tab");
  const withoutCsrf = await fetch(base, {
    method: "PUT",
    headers: { cookie: headers.cookie, "content-type": "application/json" },
    body: JSON.stringify(subscription),
  });
  expect(withoutCsrf.status).toBe(403);
  expect(((await withoutCsrf.json()) as { code: string }).code).toBe("csrf_rejected");
  const unknownKey = await fetch(base, {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...subscription, installation_id: "foreign" }),
  });
  expect(unknownKey.status).toBe(400);
  const notBound = await fetch(base, {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...subscription, rebind: true }),
  });
  expect(notBound.status).toBe(409);
  expect(((await notBound.json()) as { code: string }).code).toBe("push_subscription_not_bound");
  const stored = await fetch(base, {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...subscription, device: "44444444-4444-4444-8444-444444444444" }),
  });
  expect(stored.status).toBe(204);
  expect(await rootRows(server.userId)).toEqual([
    { tenant_id: server.tenantId, kind: "browser", installation_id: null },
  ]);
  expect(await (await fetch(base, { headers })).json()).toEqual({
    subscribed: true,
    handled_by_app: false,
  });
  const { headers: renewed } = await rootSession(server.userId);
  expect(await (await fetch(base, { headers: renewed })).json()).toEqual({
    subscribed: false,
    handled_by_app: false,
  });
  const rebound = await fetch(base, {
    method: "PUT",
    headers: renewed,
    body: JSON.stringify({ ...subscription, rebind: true }),
  });
  expect(rebound.status).toBe(204);
  expect(await (await fetch(base, { headers: renewed })).json()).toEqual({
    subscribed: true,
    handled_by_app: false,
  });
  const removed = await fetch(base, { method: "DELETE", headers: renewed });
  expect(removed.status).toBe(204);
  expect(await rootRows(server.userId)).toEqual([]);
});

test("the browser tab reports app delivery only while the installed app row on this device is live", async () => {
  const root = await browserSessionHeaders(server, server.userId);
  const created = await fetch(`${server.baseUrl}/v1/cockpit/installations`, {
    method: "POST",
    headers: root,
    body: "{}",
  });
  const { id } = (await created.json()) as { id: string };
  const base = `${server.baseUrl}/cockpit/i/${id}/api/v1/cockpit/push-subscription`;
  const cookie = created.headers.get("set-cookie") ?? "";
  const boot = await fetch(`${server.baseUrl}/cockpit/i/${id}/api/v1/cockpit/bootstrap`, {
    headers: { cookie },
  });
  const { csrf_token } = (await boot.json()) as { csrf_token: string };
  const installed = { cookie, "x-subkit-csrf": csrf_token, "content-type": "application/json" };
  await fetch(`${base}/prepare`, { method: "POST", headers: installed, body: "{}" });
  const device = "66666666-6666-4666-8666-666666666666";
  const stored = await fetch(base, {
    method: "PUT",
    headers: installed,
    body: JSON.stringify({
      ...rootSubscription("https://fcm.googleapis.com/fcm/send/installed-device"),
      device,
    }),
  });
  expect(stored.status).toBe(204);
  const { headers } = await rootSession(server.userId);
  const tab = `${server.baseUrl}/v1/cockpit/push-subscription`;
  const status = async (query: string) => await (await fetch(`${tab}${query}`, { headers })).json();
  expect(await status(`?device=${device}`)).toEqual({ subscribed: false, handled_by_app: true });
  expect(await status("?device=77777777-7777-4777-8777-777777777777")).toEqual({
    subscribed: false,
    handled_by_app: false,
  });
  expect(await status("")).toEqual({ subscribed: false, handled_by_app: false });
  expect((await fetch(`${tab}?device=not-a-device`, { headers })).status).toBe(400);
  const installationSessions = await server.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.tenant_id, server.tenantId), eq(sessions.installation_id, id)));
  await endCockpitPushForSessions(
    server.db,
    { tenant_id: server.tenantId, session_ids: installationSessions.map((row) => row.id) },
    "session_logout",
    { actor_type: "user", actor_id: server.userId },
  );
  expect(await status(`?device=${device}`)).toEqual({ subscribed: false, handled_by_app: false });
});

test("machine principals and foreign sessions never reach root push", async () => {
  const base = `${server.baseUrl}/v1/cockpit/push-subscription`;
  const apiKey = await fetch(base, { headers: { authorization: `Bearer ${server.apiKey}` } });
  expect(apiKey.status).toBe(401);
  expect(((await apiKey.json()) as { code: string }).code).toBe("browser_session_required");

  const root = await browserSessionHeaders(server, server.userId);
  const created = await fetch(`${server.baseUrl}/v1/cockpit/installations`, {
    method: "POST",
    headers: root,
    body: "{}",
  });
  const { id } = (await created.json()) as { id: string };
  const installationCookie = created.headers.get("set-cookie") ?? "";
  const installed = await fetch(
    `${server.baseUrl}/cockpit/i/${id}/api/v1/cockpit/push-subscription`,
    {
      headers: { cookie: root.cookie ?? "" },
    },
  );
  expect(installed.status).toBe(401);
  const crossed = await fetch(base, { headers: { cookie: installationCookie } });
  expect(crossed.status).toBe(401);

  const idleUser = await addUser();
  const idle = await rootSession(idleUser, {
    lastSeenAt: new Date(Date.now() - 7 * 60 * 60_000), // allow-wall-clock: live browser fixture
  });
  await server.db
    .update(sessions)
    .set({ last_seen_at: new Date(Date.now() - 9 * 60 * 60_000) }) // allow-wall-clock: live browser fixture
    .where(and(eq(sessions.tenant_id, server.tenantId), eq(sessions.id, idle.sessionId)));
  expect(
    await resolveCockpitPushContext(server.db, new Request(base, { headers: idle.headers }), {
      provider: "browser_session",
      kind: "user",
      id: idleUser,
      tenant_id: server.tenantId,
      roles: ["member"],
      session_id: idle.sessionId,
    }),
  ).toBeNull();
});

test("the resolver refuses bearer principals and never falls back on installation paths", async () => {
  const { headers, sessionId } = await rootSession(server.userId);
  const request = new Request(`${server.baseUrl}/v1/cockpit/push-subscription`, { headers });
  const principal = {
    kind: "user" as const,
    id: server.userId,
    tenant_id: server.tenantId,
    roles: ["admin"],
    session_id: sessionId,
  };
  expect(
    await resolveCockpitPushContext(server.db, request, { ...principal, provider: "oauth" }),
  ).toBeNull();
  expect(
    await resolveCockpitPushContext(server.db, request, {
      ...principal,
      provider: "browser_session",
    }),
  ).toMatchObject({ kind: "browser", tenant_id: server.tenantId, session_id: sessionId });
  expect(
    await resolveCockpitPushContext(
      server.db,
      new Request(
        `${server.baseUrl}/cockpit/i/55555555-5555-4555-8555-555555555555/api/v1/cockpit/push-subscription`,
        { headers },
      ),
      { ...principal, provider: "browser_session" },
    ),
  ).toBeNull();
});

test("root push accepts exactly the browser sessions the browser-session provider accepts", async () => {
  const base = `${server.baseUrl}/v1/cockpit/push-subscription`;
  const bootstrap = `${server.baseUrl}/v1/cockpit/bootstrap`;
  const slidingUser = await addUser();
  const sliding = await rootSession(slidingUser, {
    expiresAt: new Date(Date.now() - 60 * 60_000), // allow-wall-clock: live browser fixture
    absoluteExpiresAt: new Date(Date.now() + 6 * 60 * 60_000), // allow-wall-clock: live browser fixture
    lastSeenAt: new Date(Date.now() - 60 * 60_000), // allow-wall-clock: live browser fixture
  });
  expect((await fetch(bootstrap, { headers: sliding.headers })).status).toBe(200);
  const status = await fetch(base, { headers: sliding.headers });
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({ subscribed: false, handled_by_app: false });
  const prepared = await fetch(`${base}/prepare`, {
    method: "POST",
    headers: sliding.headers,
    body: "{}",
  });
  expect(prepared.status).toBe(200);
  const stored = await fetch(base, {
    method: "PUT",
    headers: sliding.headers,
    body: JSON.stringify(rootSubscription("https://fcm.googleapis.com/fcm/send/root-sliding")),
  });
  expect(stored.status).toBe(204);
  expect(await (await fetch(base, { headers: sliding.headers })).json()).toEqual({
    subscribed: true,
    handled_by_app: false,
  });
  expect((await fetch(base, { method: "DELETE", headers: sliding.headers })).status).toBe(204);
  expect(await rootRows(slidingUser)).toEqual([]);

  const rejected = [
    await rootSession(await addUser(), {
      revokedAt: new Date(Date.now() - 60_000), // allow-wall-clock: live browser fixture
    }),
    await rootSession(await addUser(), {
      absoluteExpiresAt: new Date(Date.now() - 60_000), // allow-wall-clock: live browser fixture
      lastSeenAt: new Date(Date.now() - 60_000), // allow-wall-clock: live browser fixture
    }),
    await rootSession(await addUser(), {
      lastSeenAt: new Date(Date.now() - 9 * 60 * 60_000), // allow-wall-clock: live browser fixture
    }),
    await rootSession(await addUser(), {
      expiresAt: new Date(Date.now() - 60_000), // allow-wall-clock: live browser fixture
    }),
  ];
  for (const session of rejected) {
    expect((await fetch(base, { headers: session.headers })).status).toBe(401);
    expect((await fetch(bootstrap, { headers: session.headers })).status).toBe(401);
  }
});

test("installation push accepts an installation session past its sliding expires_at that browser auth accepts", async () => {
  const root = await browserSessionHeaders(server, server.userId);
  const created = await fetch(`${server.baseUrl}/v1/cockpit/installations`, {
    method: "POST",
    headers: root,
    body: "{}",
  });
  expect(created.status).toBe(200);
  const { id } = (await created.json()) as { id: string };
  const cookie = created.headers.get("set-cookie") ?? "";
  await server.db
    .update(sessions)
    .set({
      expires_at: new Date(Date.now() - 60 * 60_000), // allow-wall-clock: live browser fixture
      last_seen_at: new Date(Date.now() - 60 * 60_000), // allow-wall-clock: live browser fixture
    })
    .where(and(eq(sessions.tenant_id, server.tenantId), eq(sessions.installation_id, id)));
  const base = `${server.baseUrl}/cockpit/i/${id}/api/v1`;
  expect((await fetch(`${base}/cockpit/bootstrap`, { headers: { cookie } })).status).toBe(200);
  const status = await fetch(`${base}/cockpit/push-subscription`, { headers: { cookie } });
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({ subscribed: false, handled_by_app: false });
});
