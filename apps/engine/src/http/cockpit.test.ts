import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  browserSessionCookie,
  browserSessionForPrincipal,
  signBrowserCsrf,
  signBrowserSession,
  verifyBrowserCsrf,
} from "../auth/browser-session.ts";
import {
  cockpitBundleMissing,
  cockpitCsp,
  inlineScriptHashes,
  registerCockpitRoutesWith,
} from "./cockpit.ts";
import { browserCsrfMiddleware } from "./middleware/browser-csrf.ts";
import { createOpenApiApp } from "./openapi.ts";
import { registerCockpitIdentityRoutes } from "./routes/identity/cockpit.ts";

const cockpitPublic = new URL("../../../cockpit/public/", import.meta.url);
const fixtureShell = [
  "<!doctype html>",
  '<html lang="en"><head><title>SubKit Cockpit</title>',
  '<link rel="icon" type="image/svg+xml" href="/cockpit/favicon.svg" />',
  "<script>document.documentElement.dataset.theme = 'light';</script>",
  '<script type="module" src="/cockpit/assets/index-fixture.js"></script>',
  "</head><body></body></html>",
].join("\n");
const fixtureFiles: Record<string, Uint8Array> = {
  "index.html": new TextEncoder().encode(fixtureShell),
  "assets/index-fixture.js": new TextEncoder().encode("export {};\n"),
  "favicon.svg": readFileSync(new URL("favicon.svg", cockpitPublic)),
  "app-icon-192.png": readFileSync(new URL("app-icon-192.png", cockpitPublic)),
  "app-icon-512.png": readFileSync(new URL("app-icon-512.png", cockpitPublic)),
  "browser-worker.js": readFileSync(new URL("browser-worker.js", cockpitPublic)),
  "installation-worker.js": readFileSync(new URL("installation-worker.js", cockpitPublic)),
};
const registerCockpitRoutes = (app: Parameters<typeof registerCockpitRoutesWith>[0]) =>
  registerCockpitRoutesWith(app, (path) => fixtureFiles[path] ?? null);

describe("cockpit browser boundary", () => {
  test("serves /cockpit as the canonical shell URL without redirecting", async () => {
    const app = createOpenApiApp();
    registerCockpitRoutes(app);

    const response = await app.request("http://subkit.test/cockpit");

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain("SubKit Cockpit");
  });

  test("serves the embedded shell with a hash-based script policy", async () => {
    const app = createOpenApiApp();
    registerCockpitRoutes(app);

    const response = await app.request("http://subkit.test/cockpit/chat");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-security-policy")).toContain("sha256-");
    expect(response.headers.get("content-security-policy")).not.toContain(
      "script-src 'unsafe-inline'",
    );
    expect(html).toContain("SubKit Cockpit");
  });

  test("returns immutable assets and supports conditional requests", async () => {
    const app = createOpenApiApp();
    registerCockpitRoutes(app);
    const shell = await app.request("http://subkit.test/cockpit/");
    const html = await shell.text();
    const assetPath = html.match(/(?:src|href)="(\/cockpit\/assets\/[^"]+)"/)?.[1];
    expect(assetPath).toBeDefined();
    if (!assetPath) return;

    const asset = await app.request(`http://subkit.test${assetPath}`);
    const etag = asset.headers.get("etag");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(etag).toBeTruthy();

    const cached = await app.request(`http://subkit.test${assetPath}`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(cached.status).toBe(304);
  });

  test("a bundle file a stale tab still asks for is missing, not the page", async () => {
    const app = createOpenApiApp();
    registerCockpitRoutes(app);

    const response = await app.request("http://subkit.test/cockpit/assets/index-gone.js");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  test("spelling one bundle file many ways still serves the same file", async () => {
    const app = createOpenApiApp();
    registerCockpitRoutes(app);
    const html = await (await app.request("http://subkit.test/cockpit/")).text();
    const assetPath = html.match(/(?:src|href)="\/cockpit\/(assets\/[^"]+)"/)?.[1];
    expect(assetPath).toBeDefined();
    if (!assetPath) return;

    const canonical = await app.request(`http://subkit.test/cockpit/${assetPath}`);
    const variant = await app.request(`http://subkit.test/cockpit/${assetPath.replace("/", "//")}`);

    expect(variant.status).toBe(canonical.status);
    expect(variant.headers.get("etag")).toBe(canonical.headers.get("etag"));
  });

  test("the app icon keeps no long cache because its name carries no content hash", async () => {
    const app = createOpenApiApp();
    registerCockpitRoutes(app);

    const icon = await app.request("http://subkit.test/cockpit/favicon.svg");

    expect(icon.status).toBe(200);
    expect(icon.headers.get("cache-control")).toBe("no-cache");
  });

  test("serves the browser tab push worker as an uncached script under the Cockpit policy", async () => {
    const app = createOpenApiApp();
    registerCockpitRoutes(app);
    const shell = await app.request("http://subkit.test/cockpit/");
    const source = readFileSync(
      new URL("../../../cockpit/public/browser-worker.js", import.meta.url),
      "utf8",
    );

    const worker = await app.request("http://subkit.test/cockpit/sw.js");
    expect(worker.status).toBe(200);
    expect(worker.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(worker.headers.get("cache-control")).toBe("private, no-store");
    expect(worker.headers.get("x-content-type-options")).toBe("nosniff");
    expect(worker.headers.get("service-worker-allowed")).toBeNull();
    expect(worker.headers.get("etag")).toBeNull();
    expect(worker.headers.get("content-security-policy")).toBe(
      shell.headers.get("content-security-policy"),
    );
    expect(await worker.text()).toBe(source);

    const head = await app.request("http://subkit.test/cockpit/sw.js", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(await head.text()).toBe("");

    const page = await app.request("http://subkit.test/cockpit/settings");
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("serves the app icon under the cockpit base path, as an image", async () => {
    const app = createOpenApiApp();
    registerCockpitRoutes(app);

    const shell = await app.request("http://subkit.test/cockpit/");
    const href = (await shell.text()).match(/<link[^>]+rel="icon"[^>]+href="([^"]+)"/)?.[1];
    expect(href).toBe("/cockpit/favicon.svg");

    const icon = await app.request(`http://subkit.test${href}`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(await icon.text()).toContain("<svg");

    const doubled = await app.request("http://subkit.test/cockpit/cockpit/favicon.svg");
    expect(doubled.status).toBe(200);
    expect(doubled.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("binds CSRF proofs to one browser session", async () => {
    const session = { session_id: "session-a", user_id: "user-a", tenant_id: "tenant-a" };
    const token = await signBrowserCsrf(session);
    expect(await verifyBrowserCsrf(token, session)).toBe(true);
    expect(await verifyBrowserCsrf(token, { ...session, tenant_id: "tenant-b" })).toBe(false);
  });

  test("recognizes an OIDC principal backed by the shared browser session cookie", async () => {
    const session = { session_id: "session-a", user_id: "user-a", tenant_id: "tenant-a" };
    const cookie = browserSessionCookie(await signBrowserSession(session));
    const payload = await browserSessionForPrincipal(
      new Request("http://subkit.test/cockpit/", { headers: { cookie } }),
      {
        provider: "oidc",
        kind: "user",
        id: session.user_id,
        tenant_id: session.tenant_id,
        session_id: session.session_id,
        roles: ["admin"],
      },
    );
    expect(payload).toEqual(session);
  });

  test("rejects browser writes without a matching CSRF proof", async () => {
    const session = { session_id: "session-a", user_id: "user-a", tenant_id: "tenant-a" };
    const cookie = browserSessionCookie(await signBrowserSession(session));
    const csrf = await signBrowserCsrf(session);
    const app = createOpenApiApp();
    app.use("*", async (c, next) => {
      c.set("principal", {
        provider: "oidc",
        kind: "user",
        id: session.user_id,
        tenant_id: session.tenant_id,
        session_id: session.session_id,
        roles: [],
      });
      return await next();
    });
    app.use("*", browserCsrfMiddleware());
    app.post("/write", (c) => c.json({ ok: true }));

    const rejected = await app.request("http://subkit.test/write", {
      method: "POST",
      headers: { cookie },
    });
    expect(rejected.status).toBe(403);

    const accepted = await app.request("http://subkit.test/write", {
      method: "POST",
      headers: { cookie, "x-subkit-csrf": csrf },
    });
    expect(accepted.status).toBe(200);

    const crossSite = await app.request("http://subkit.test/write", {
      method: "POST",
      headers: { cookie, "sec-fetch-site": "cross-site", "x-subkit-csrf": csrf },
    });
    expect(crossSite.status).toBe(403);
  });

  test("allows only the exact single-use credential grant form targets", async () => {
    const session = { session_id: "session-a", user_id: "user-a", tenant_id: "tenant-a" };
    const cookie = browserSessionCookie(await signBrowserSession(session));
    const app = createOpenApiApp();
    app.use("*", async (c, next) => {
      c.set("principal", {
        provider: "oidc",
        kind: "user",
        id: session.user_id,
        tenant_id: session.tenant_id,
        session_id: session.session_id,
        roles: [],
      });
      return await next();
    });
    app.use("*", browserCsrfMiddleware());
    app.post("/v1/connectors/:id/credentials/setup", (c) => c.json({ ok: true }));
    app.post("/v1/connector-drafts/:id/credentials/setup", (c) => c.json({ ok: true }));
    app.put("/v1/connector-drafts/:id/credentials/setup", (c) => c.json({ ok: true }));
    app.post("/v1/connector-drafts/:id", (c) => c.json({ ok: true }));
    app.post("/v1/connector-drafts/:id/credentials/setup/extra", (c) => c.json({ ok: true }));

    for (const path of [
      "/v1/connectors/connector-a/credentials/setup",
      "/v1/connector-drafts/conversation-a/credentials/setup",
    ]) {
      const accepted = await app.request(`http://subkit.test${path}`, {
        method: "POST",
        headers: { cookie },
      });
      expect(accepted.status).toBe(200);
    }

    for (const path of [
      "/v1/connector-drafts/conversation-a",
      "/v1/connector-drafts/conversation-a/credentials/setup/extra",
    ]) {
      const rejected = await app.request(`http://subkit.test${path}`, {
        method: "POST",
        headers: { cookie },
      });
      expect(rejected.status).toBe(403);
    }

    const wrongMethod = await app.request(
      "http://subkit.test/v1/connector-drafts/conversation-a/credentials/setup",
      { method: "PUT", headers: { cookie } },
    );
    expect(wrongMethod.status).toBe(403);
  });

  test("hashes only inline scripts", () => {
    const html = '<script>window.theme="dark"</script><script src="/cockpit/app.js"></script>';
    const hashes = inlineScriptHashes(html);
    expect(hashes).toHaveLength(1);
    expect(cockpitCsp(hashes)).toContain(hashes[0] ?? "missing");
  });

  test("keeps login return paths inside the cockpit route", async () => {
    const app = createOpenApiApp();
    registerCockpitIdentityRoutes(app);
    const rejected = await app.request(
      "http://subkit.test/v1/identity/cockpit-login?return_to=/cockpit-evil",
    );
    expect(rejected.status).toBe(400);

    const accepted = await app.request(
      "http://subkit.test/v1/identity/cockpit-login?return_to=/cockpit/chat",
    );
    expect(accepted.status).toBe(302);
    expect(accepted.headers.get("location")).toStartWith("/v1/identity/login/start?login_state=");

    const overlay = await app.request(
      `http://subkit.test/v1/identity/cockpit-login?return_to=${encodeURIComponent("/cockpit?run=abc")}`,
    );
    expect(overlay.status).toBe(302);
  });
});

describe("an installation built without the cockpit", () => {
  const missing = () => {
    const app = createOpenApiApp();
    app.get("/cockpit", cockpitBundleMissing);
    return app;
  };

  test("an API client keeps the plain-text answer", async () => {
    const response = await missing().request("http://subkit.test/cockpit", {
      headers: { accept: "*/*" },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toStartWith("text/plain");
    expect(await response.text()).toBe("the SubKit Cockpit was not built into this deployment\n");
    expect(response.headers.get("vary")).toBe("Accept, Cookie");
  });

  test("a browser gets the designed page, and caches know it depends on Accept and cookies", async () => {
    const response = await missing().request("http://subkit.test/cockpit", {
      headers: { accept: "text/html", cookie: "sk_locale=de" },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("vary")).toBe("Accept, Cookie");
    const html = await response.text();
    expect(html).toContain("Das Cockpit fehlt");
    expect(html.match(/<a\s/g)?.length).toBe(1);
  });
});
