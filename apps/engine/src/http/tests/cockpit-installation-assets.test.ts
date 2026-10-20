import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

let server: HttpTestServer;

beforeAll(async () => {
  server = await createHttpTestServer("cockpit-installation-assets");
});

afterAll(async () => {
  if (server) await server.cleanup();
});

async function createInstallation(headers: Record<string, string>): Promise<{
  id: string;
  manifest_url: string;
  cookie: string;
}> {
  const response = await fetch(`${server.baseUrl}/v1/cockpit/installations`, {
    method: "POST",
    headers,
    body: "{}",
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { id: string; manifest_url: string };
  return { ...body, cookie: response.headers.get("set-cookie") ?? "" };
}

describe("Cockpit installation assets", () => {
  test("keeps tenant manifest and icon private while the app shell and worker stay neutral", async () => {
    const rootHeaders = await browserSessionHeaders(server, server.userId);
    const branding = await fetch(`${server.baseUrl}/v1/tenant/branding`, {
      method: "PUT",
      headers: rootHeaders,
      body: JSON.stringify({
        revision: 0,
        display_name: "Workspace Brand",
        subtitle: null,
        palette: "indigo",
        logos: { light: { operation: "keep" }, dark: { operation: "keep" } },
        app_icon: { operation: "keep" },
      }),
    });
    expect(branding.status).toBe(200);
    const installation = await createInstallation(rootHeaders);

    const manifest = await fetch(`${server.baseUrl}${installation.manifest_url}`, {
      headers: { cookie: installation.cookie },
    });
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("cache-control")).toBe("private, no-store");
    expect(manifest.headers.get("vary")).toBe("Cookie");
    const body = (await manifest.json()) as {
      name: string;
      short_name: string;
      scope: string;
      icons: Array<{ src: string }>;
    };
    expect(body.name).toBe("Test cockpit-installation-assets");
    expect(body.short_name).toBe(body.name);
    expect(body.scope).toBe(`/cockpit/i/${installation.id}/`);
    expect(body.icons).toHaveLength(2);

    const icon = await fetch(`${server.baseUrl}${body.icons[0]?.src}`, {
      headers: { cookie: installation.cookie },
    });
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(icon.headers.get("cache-control")).toBe("private, no-store");

    const rootManifest = await fetch(`${server.baseUrl}${installation.manifest_url}`, {
      headers: rootHeaders,
    });
    expect(rootManifest.status).toBe(401);
    expect(rootManifest.headers.get("cache-control")).toBe("private, no-store");

    const shell = await fetch(`${server.baseUrl}/cockpit/i/${installation.id}/`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("cache-control")).toBe("private, no-store");
    expect(shell.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const shellHtml = await shell.text();
    expect(shellHtml).not.toContain(server.tenantId);
    expect(shellHtml).not.toContain(installation.id);
    expect(shellHtml).not.toContain("Test cockpit-installation-assets");

    const worker = await fetch(`${server.baseUrl}/cockpit/i/${installation.id}/sw.js`);
    expect(worker.status).toBe(200);
    expect(worker.headers.get("cache-control")).toBe("private, no-store");
    expect(worker.headers.get("service-worker-allowed")).toBe(`/cockpit/i/${installation.id}/`);
    expect(worker.headers.get("content-type")).toBe("application/javascript; charset=utf-8");

    const invalid = await fetch(`${server.baseUrl}/cockpit/i/not-a-uuid/sw.js`);
    expect(invalid.status).toBe(404);
    expect(invalid.headers.get("cache-control")).toBe("private, no-store");

    const revoked = await fetch(`${server.baseUrl}/v1/cockpit/installations/${installation.id}`, {
      method: "DELETE",
      headers: rootHeaders,
    });
    expect(revoked.status).toBe(204);
    const staleManifest = await fetch(`${server.baseUrl}${installation.manifest_url}`, {
      headers: { cookie: installation.cookie },
    });
    expect(staleManifest.status).toBe(401);
    expect(staleManifest.headers.get("cache-control")).toBe("private, no-store");
  });
});
