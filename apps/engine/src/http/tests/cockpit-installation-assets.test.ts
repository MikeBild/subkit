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
      id: string;
      name: string;
      short_name: string;
      scope: string;
      start_url: string;
      display: string;
      lang: string;
      theme_color: string;
      icons: Array<{ src: string; purpose: string }>;
      shortcuts: Array<{ name: string; url: string }>;
      protocol_handlers: Array<{ protocol: string; url: string }>;
      launch_handler: { client_mode: string[] };
      share_target: { action: string };
    };
    const base = `/cockpit/i/${installation.id}/`;
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
    expect(body.name).toBe("Test cockpit-installation-assets");
    expect(body.short_name).toBe(body.name);
    expect(body.scope).toBe(base);
    expect(body.start_url).toBe(base);
    expect(body.id).toBe(base);
    expect(body.display).toBe("standalone");
    expect(body.theme_color).toBe("#4f46e5");
    expect(body.lang).toBe("en");
    expect(body.icons.map((entry) => entry.purpose)).toEqual([
      "any",
      "any",
      "maskable",
      "maskable",
      "monochrome",
    ]);
    expect(body.shortcuts.map((shortcut) => shortcut.url)).toEqual([
      `${base}chat`,
      `${base}tasks`,
      `${base}intake`,
    ]);
    expect(body.protocol_handlers).toEqual([{ protocol: "web+subkit", url: `${base}?link=%s` }]);
    expect(body.launch_handler.client_mode[0]).toBe("focus-existing");
    expect(body.share_target.action).toBe(`${base}incoming/share`);

    const german = await fetch(`${server.baseUrl}${installation.manifest_url}`, {
      headers: { cookie: `${installation.cookie.split(";")[0]}; sk_locale=de` },
    });
    const germanBody = (await german.json()) as { lang: string; shortcuts: { name: string }[] };
    expect(germanBody.lang).toBe("de");
    expect(germanBody.shortcuts.map((shortcut) => shortcut.name)).toEqual([
      "Chat",
      "Aufgaben",
      "Eingang",
    ]);

    for (const entry of body.icons) {
      const variant = await fetch(`${server.baseUrl}${entry.src}`, {
        headers: { cookie: installation.cookie },
      });
      expect(variant.status, entry.src).toBe(200);
      expect(variant.headers.get("content-type")).toBe("image/png");
      expect(variant.headers.get("cache-control")).toBe("private, no-store");
    }
    const signedOutIcon = await fetch(`${server.baseUrl}${body.icons[2]?.src}`);
    expect(signedOutIcon.status).toBe(404);
    const unknownIcon = await fetch(`${server.baseUrl}${base}icon/1024.png?revision=1`, {
      headers: { cookie: installation.cookie },
    });
    expect(unknownIcon.status).toBe(404);

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
    const workerSource = await worker.text();
    expect(workerSource).toContain("incoming/share");
    expect(workerSource).toMatch(
      /^self\.COCKPIT_BUILD = "[0-9a-f]{16}";\nself\.COCKPIT_SHELL = \[/,
    );
    expect(workerSource).toContain("self.subkitNotify = {");
    expect(workerSource).not.toContain(installation.id);
    expect(workerSource).not.toContain(server.tenantId);
    const shellFiles = JSON.parse(
      /^self\.COCKPIT_SHELL = (\[.*\]);$/m.exec(workerSource)?.[1] ?? "[]",
    ) as string[];
    expect(shellFiles.length).toBeGreaterThan(0);
    for (const file of shellFiles) {
      expect(file).toMatch(/^\/cockpit\/assets\/[A-Za-z0-9._-]+$/);
      expect(shellHtml.includes(file) || file.includes("-")).toBeTrue();
    }
    const again = await fetch(`${server.baseUrl}/cockpit/i/${installation.id}/sw.js`);
    expect(await again.text()).toBe(workerSource);
    const policy = shell.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("worker-src 'self'");
    expect(policy).toContain("manifest-src 'self'");
    expect(policy).toContain("connect-src 'self'");

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
