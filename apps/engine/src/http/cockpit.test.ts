import { describe, expect, test } from "bun:test";
import {
  browserSessionCookie,
  browserSessionForPrincipal,
  signBrowserCsrf,
  signBrowserSession,
  verifyBrowserCsrf,
} from "../auth/browser-session.ts";
import { cockpitCsp, inlineScriptHashes, registerCockpitRoutes } from "./cockpit.ts";
import { browserCsrfMiddleware } from "./middleware/browser-csrf.ts";
import { createOpenApiApp } from "./openapi.ts";
import { registerCockpitIdentityRoutes } from "./routes/identity/cockpit.ts";

describe("cockpit browser boundary", () => {
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
    expect(html).toContain("Subkit Cockpit");
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
  });
});
