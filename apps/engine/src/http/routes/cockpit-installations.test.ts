import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  browserSessionFromRequest,
  issueBrowserSession,
  signBrowserCsrf,
  verifyBrowserSession,
} from "../../auth/browser-session.ts";
import { cockpitInstallations } from "../../db/schema/cockpit-installations.ts";
import { sessions } from "../../db/schema/identity.ts";
import { createOrReuseDesktopInstallation } from "../../identity/index.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  createSecondaryTenant,
  type HttpTestServer,
} from "../tests/setup.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

let server: HttpTestServer;

beforeAll(async () => {
  server = await createHttpTestServer("cockpit-installations");
});

afterAll(async () => {
  if (server) await server.cleanup();
});

async function createInstallation(headers: Record<string, string>): Promise<Response> {
  return await fetch(`${server.baseUrl}/v1/cockpit/installations`, {
    method: "POST",
    headers,
    body: "{}",
  });
}

test("an installation is idempotent, uses a scoped session, and rejects root fallback", async () => {
  const rootHeaders = await browserSessionHeaders(server, server.userId);
  const first = await createInstallation(rootHeaders);
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as {
    id: string;
    start_url: string;
    manifest_url: string;
    created: boolean;
  };
  expect(firstBody.created).toBe(true);
  expect(firstBody.start_url).toBe(`/cockpit/i/${firstBody.id}/`);
  expect(firstBody.manifest_url).toBe(`/cockpit/i/${firstBody.id}/manifest.webmanifest`);
  const installationCookie = first.headers.get("set-cookie");
  expect(installationCookie).toContain(`Path=/cockpit/i/${firstBody.id}/`);

  const second = await createInstallation(await browserSessionHeaders(server, server.userId));
  expect(second.status).toBe(200);
  expect((await second.json()) as { id: string; created: boolean }).toMatchObject({
    id: firstBody.id,
    created: false,
  });

  const fallback = await fetch(
    `${server.baseUrl}/cockpit/i/${firstBody.id}/api/v1/cockpit/bootstrap`,
    { headers: rootHeaders },
  );
  expect(fallback.status).toBe(401);

  const scoped = await fetch(
    `${server.baseUrl}/cockpit/i/${firstBody.id}/api/v1/cockpit/bootstrap`,
    { headers: { cookie: installationCookie ?? "" } },
  );
  expect(scoped.status).toBe(200);

  const manifest = await fetch(`${server.baseUrl}${firstBody.manifest_url}`, {
    headers: { cookie: installationCookie ?? "" },
  });
  expect(manifest.status).toBe(200);
  expect(manifest.headers.get("cache-control")).toBe("private, no-store");
  expect(((await manifest.json()) as { id: string }).id).toBe(firstBody.start_url);

  const rootManifest = await fetch(`${server.baseUrl}${firstBody.manifest_url}`, {
    headers: rootHeaders,
  });
  expect(rootManifest.status).toBe(401);

  const invalid = await fetch(`${server.baseUrl}/cockpit/i/not-a-uuid/api/v1/cockpit/bootstrap`, {
    headers: rootHeaders,
  });
  expect(invalid.status).toBe(404);

  const csrfRejected = await fetch(
    `${server.baseUrl}/cockpit/i/${firstBody.id}/api/v1/identity/logout`,
    {
      method: "POST",
      headers: { cookie: installationCookie ?? "" },
    },
  );
  expect(csrfRejected.status).toBe(403);
});

test("revocation invalidates all installation sessions and a replacement gets a new id", async () => {
  const rootHeaders = await browserSessionHeaders(server, server.userId);
  const created = await createInstallation(rootHeaders);
  const body = (await created.json()) as { id: string };
  const installationCookie = created.headers.get("set-cookie") ?? "";

  const revoked = await fetch(`${server.baseUrl}/v1/cockpit/installations/${body.id}`, {
    method: "DELETE",
    headers: rootHeaders,
  });
  expect(revoked.status).toBe(204);

  const stale = await fetch(`${server.baseUrl}/cockpit/i/${body.id}/api/v1/cockpit/bootstrap`, {
    headers: { cookie: installationCookie },
  });
  expect(stale.status).toBe(403);
  expect(JSON.stringify(await stale.json())).toContain("installation_revoked");

  const replacement = await createInstallation(rootHeaders);
  expect(replacement.status).toBe(200);
  const replacementBody = (await replacement.json()) as { id: string; created: boolean };
  expect(replacementBody.created).toBe(true);
  expect(replacementBody.id).not.toBe(body.id);

  const installations = await server.db
    .select({ id: cockpitInstallations.id, revoked_at: cockpitInstallations.revoked_at })
    .from(cockpitInstallations)
    .where(eq(cockpitInstallations.tenant_id, server.tenantId));
  expect(installations.filter((installation) => installation.revoked_at === null)).toHaveLength(1);
});

test("two tenant installations reject each other's scoped cookies", async () => {
  const first = await createInstallation(await browserSessionHeaders(server, server.userId));
  const firstBody = (await first.json()) as { id: string };
  const secondary = await createSecondaryTenant(server, "installation-isolation");
  const second = await createInstallation(await secondary.admin.sessionHeaders());
  const secondBody = (await second.json()) as { id: string };
  const secondCookie = second.headers.get("set-cookie") ?? "";
  const foreign = await fetch(
    `${server.baseUrl}/cockpit/i/${firstBody.id}/api/v1/cockpit/bootstrap`,
    { headers: { cookie: secondCookie } },
  );
  expect(foreign.status).toBe(401);
  const own = await fetch(`${server.baseUrl}/cockpit/i/${secondBody.id}/api/v1/cockpit/bootstrap`, {
    headers: { cookie: secondCookie },
  });
  expect(own.status).toBe(200);
});

test("installation logout clears only its scoped cookie", async () => {
  const rootHeaders = await browserSessionHeaders(server, server.userId);
  const created = await createInstallation(rootHeaders);
  const body = (await created.json()) as { id: string };
  const installationCookie = created.headers.get("set-cookie") ?? "";
  const payload = await browserSessionFromRequest(
    new Request(`${server.baseUrl}/cockpit/i/${body.id}/api/v1/identity/logout`, {
      headers: { cookie: installationCookie },
    }),
  );
  if (!payload) throw new Error("installation session payload missing");
  const logout = await fetch(`${server.baseUrl}/cockpit/i/${body.id}/api/v1/identity/logout`, {
    method: "POST",
    headers: { cookie: installationCookie, "x-subkit-csrf": await signBrowserCsrf(payload) },
  });
  expect(logout.status).toBe(204);
  expect(logout.headers.get("set-cookie")).toContain(`Path=/cockpit/i/${body.id}/`);
  expect(
    (await fetch(`${server.baseUrl}/v1/cockpit/bootstrap`, { headers: rootHeaders })).status,
  ).toBe(200);
});

test("concurrent creation produces one active installation", async () => {
  const headers = await browserSessionHeaders(server, server.userId);
  const responses = await Promise.all(Array.from({ length: 8 }, () => createInstallation(headers)));
  const bodies = await Promise.all(
    responses.map(async (response) => (await response.json()) as { id: string }),
  );
  expect(new Set(bodies.map((body) => body.id)).size).toBe(1);
});

test("an expired app approval navigation hands off to its own login without granting root access", async () => {
  const rootHeaders = await browserSessionHeaders(server, server.userId);
  const response = await createInstallation(rootHeaders);
  const { id } = (await response.json()) as { id: string };
  const target = `/cockpit/i/${id}/api/v1/tool-approvals/decide?grant=opaque-review-fixture`;
  const approval = await fetch(`${server.baseUrl}${target}`, {
    headers: rootHeaders,
    redirect: "manual",
  });
  expect(approval.status).toBe(302);
  const login = new URL(approval.headers.get("location") ?? "", server.baseUrl);
  expect(login.pathname).toBe(`/cockpit/i/${id}/api/v1/identity/cockpit-login`);
  expect(login.searchParams.get("return_to")).toBe(target);
  expect(approval.headers.get("set-cookie")).toBeNull();
});

test("current installation management is private, owner-scoped and never issues a session on GET", async () => {
  const root = await browserSessionHeaders(server, server.userId);
  const created = await createInstallation(root);
  const { id } = (await created.json()) as { id: string };
  const response = await fetch(`${server.baseUrl}/v1/cockpit/installations`, { headers: root });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await response.json()).toMatchObject({ installation: { id } });
  const apiKey = await fetch(`${server.baseUrl}/v1/cockpit/installations`, {
    headers: { authorization: `Bearer ${server.apiKey}` },
  });
  expect(apiKey.status).toBe(401);
  const revoked = await fetch(`${server.baseUrl}/v1/cockpit/installations/${id}`, {
    method: "DELETE",
    headers: root,
  });
  expect(revoked.status).toBe(204);
  const empty = await fetch(`${server.baseUrl}/v1/cockpit/installations`, { headers: root });
  expect(await empty.json()).toEqual({ installation: null, installations: [] });
});

const DEVICE_IDS: Record<string, string> = {
  Laptop: "d0000000-0000-4000-8000-000000000001",
  Studio: "d0000000-0000-4000-8000-000000000002",
  Lifetime: "d0000000-0000-4000-8000-000000000003",
  Capped: "d0000000-0000-4000-8000-000000000004",
};

async function desktopDevice(label: keyof typeof DEVICE_IDS & string) {
  const { installation } = await createOrReuseDesktopInstallation(
    server.db,
    server.tenantId,
    server.userId,
    { device_id: DEVICE_IDS[label] ?? "", device_label: label },
  );
  const issued = await issueBrowserSession({
    db: server.db,
    tenantId: server.tenantId,
    userId: server.userId,
    installationId: installation.id,
    redirectTo: `/cockpit/i/${installation.id}/`,
    via: "desktop_login",
  });
  const setCookie = issued.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const jwt = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  const payload = await verifyBrowserSession(jwt);
  if (!payload) throw new Error("desktop session was not issued");
  const csrf = await signBrowserCsrf(payload);
  return {
    id: installation.id,
    sessionId: payload.session_id,
    setCookie,
    headers: { cookie, "x-subkit-csrf": csrf, "content-type": "application/json" },
    api: `${server.baseUrl}/cockpit/i/${installation.id}/api`,
  };
}

test("devices are listed with kind, label, last use and a marker for the asking one", async () => {
  const root = await browserSessionHeaders(server, server.userId);
  const laptop = await desktopDevice("Laptop");
  const studio = await desktopDevice("Studio");
  const fromBrowser = (await (
    await fetch(`${server.baseUrl}/v1/cockpit/installations`, { headers: root })
  ).json()) as {
    installations: {
      id: string;
      kind: string;
      device_label: string | null;
      last_used_at: string | null;
      current: boolean;
    }[];
  };
  const listed = fromBrowser.installations.filter((entry) =>
    [laptop.id, studio.id].includes(entry.id),
  );
  expect(listed.map((entry) => [entry.kind, entry.device_label, entry.current])).toEqual([
    ["desktop", "Laptop", false],
    ["desktop", "Studio", false],
  ]);
  expect(listed.every((entry) => typeof entry.last_used_at === "string")).toBe(true);

  const fromDevice = await fetch(`${laptop.api}/v1/cockpit/installations`, {
    headers: laptop.headers,
  });
  expect(fromDevice.status).toBe(200);
  const own = (await fromDevice.json()) as {
    installation: unknown;
    installations: { id: string; current: boolean }[];
  };
  expect(own.installation).toBeNull();
  expect(own.installations.filter((entry) => entry.current).map((entry) => entry.id)).toEqual([
    laptop.id,
  ]);

  const foreign = await fetch(`${laptop.api}/v1/cockpit/installations/${studio.id}`, {
    method: "DELETE",
    headers: laptop.headers,
  });
  expect(foreign.status).toBe(403);
  expect(((await foreign.json()) as { code: string }).code).toBe("own_installation_only");

  const self = await fetch(`${laptop.api}/v1/cockpit/installations/${laptop.id}`, {
    method: "DELETE",
    headers: laptop.headers,
  });
  expect(self.status).toBe(204);
  const after = await fetch(`${laptop.api}/v1/cockpit/bootstrap`, { headers: laptop.headers });
  expect(after.status).toBe(403);
  const other = await fetch(`${studio.api}/v1/cockpit/bootstrap`, { headers: studio.headers });
  expect(other.status).toBe(200);
  await fetch(`${server.baseUrl}/v1/cockpit/installations/${studio.id}`, {
    method: "DELETE",
    headers: root,
  });
});

test("a desktop session lives 30 days without use and 90 days at most, and ends at once when revoked", async () => {
  const device = await desktopDevice("Lifetime");
  expect(device.setCookie).toContain(`Max-Age=${90 * 24 * 60 * 60}`);
  const [row] = await server.db.select().from(sessions).where(eq(sessions.id, device.sessionId));
  const issuedAt = row?.created_at.getTime() ?? 0;
  expect((row?.absolute_expires_at?.getTime() ?? 0) - issuedAt).toBeGreaterThan(89 * DAY_MS);
  expect((row?.absolute_expires_at?.getTime() ?? 0) - issuedAt).toBeLessThan(91 * DAY_MS);
  const seen = async (daysAgo: number) => {
    await server.db
      .update(sessions)
      .set({ last_seen_at: new Date(Date.now() - daysAgo * DAY_MS) }) // allow-wall-clock: the live server judges idle time against the real clock
      .where(eq(sessions.id, device.sessionId));
    return (await fetch(`${device.api}/v1/cockpit/bootstrap`, { headers: device.headers })).status;
  };
  expect(await seen(29)).toBe(200);
  await Bun.sleep(50);
  const [renewed] = await server.db
    .select({ last_seen_at: sessions.last_seen_at })
    .from(sessions)
    .where(eq(sessions.id, device.sessionId));
  expect(Date.now() - (renewed?.last_seen_at?.getTime() ?? 0)).toBeLessThan(60_000); // allow-wall-clock: the live server renews against the real clock
  expect(await seen(31)).toBe(401);

  const capped = await desktopDevice("Capped");
  await server.db
    .update(sessions)
    .set({ absolute_expires_at: new Date(Date.now() - 1000) }) // allow-wall-clock: the live server judges the absolute end against the real clock
    .where(eq(sessions.id, capped.sessionId));
  expect(
    (await fetch(`${capped.api}/v1/cockpit/bootstrap`, { headers: capped.headers })).status,
  ).toBe(401);

  const browser = await createInstallation(await browserSessionHeaders(server, server.userId));
  const browserBody = (await browser.json()) as { id: string };
  const browserCookie = (browser.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  await server.db
    .update(sessions)
    .set({ last_seen_at: new Date(Date.now() - 9 * 60 * 60 * 1000) }) // allow-wall-clock: the live server judges idle time against the real clock
    .where(eq(sessions.installation_id, browserBody.id));
  const idleWebApp = await fetch(
    `${server.baseUrl}/cockpit/i/${browserBody.id}/api/v1/cockpit/bootstrap`,
    { headers: { cookie: browserCookie } },
  );
  expect(idleWebApp.status).toBe(401);
});
