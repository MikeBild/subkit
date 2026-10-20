import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { browserSessionFromRequest, signBrowserCsrf } from "../../auth/browser-session.ts";
import { cockpitInstallations } from "../../db/schema/cockpit-installations.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  createSecondaryTenant,
  type HttpTestServer,
} from "../tests/setup.ts";

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
  expect(stale.status).toBe(401);

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
