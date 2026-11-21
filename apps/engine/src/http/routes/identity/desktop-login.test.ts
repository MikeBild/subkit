import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  signDesktopLoginRequest,
  verifyDesktopLoginRequest,
  verifyLoginState,
} from "../../../auth/index.ts";
import * as loader from "../../../config/loader.ts";
import type { AppEnv } from "../../openapi.ts";
import { registerDesktopLoginRoutes } from "./desktop-login.ts";
import {
  renderDesktopAppOutdated,
  renderDesktopLoginConfirm,
  renderDesktopLoginExpired,
} from "./desktop-login-pages.ts";

const ORIGIN = "http://127.0.0.1";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const STATE = "state-0123456789abcdef";
const DEVICE_ID = "7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const CODE = "c".repeat(43);

beforeAll(async () => {
  try {
    loader.getConfig();
  } catch {
    await loader.loadConfig({
      env: { DATABASE_URL: "postgres://placeholder/desktop-login-test", NODE_ENV: "test" },
      configPathOverride: join(
        mkdtempSync(join(tmpdir(), "sk-cfg-desktop-")),
        "subkit.config.json",
      ),
    });
  }
});

function buildApp(ip = "198.51.100.1"): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("client_ip", ip);
    await next();
  });
  registerDesktopLoginRoutes(app);
  return app;
}

function startUrl(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: STATE,
    device_id: DEVICE_ID,
    device_label: "Mike's MacBook",
    app_version: "0.1.0",
    ...overrides,
  });
  return `${ORIGIN}/v1/identity/desktop-login/start?${params.toString()}`;
}

function exchange(app: OpenAPIHono<AppEnv>, headers: Record<string, string>, body: unknown) {
  return app.request(`${ORIGIN}/v1/identity/desktop-session`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /v1/identity/desktop-login/start", () => {
  test("carries the challenge, state and device to the confirmation step in a signed request", async () => {
    const res = await buildApp("198.51.100.10").request(startUrl());
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const location = new URL(res.headers.get("location") ?? "", ORIGIN);
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/v1/identity/desktop-login/confirm");
    expect(await verifyDesktopLoginRequest(location.searchParams.get("request") ?? "")).toEqual({
      code_challenge: CHALLENGE,
      state: STATE,
      device_id: DEVICE_ID,
      device_label: "Mike's MacBook",
      app_version: "0.1.0",
    });
  });

  test("an app below the minimum version, or one that names none, gets the update page and no request", async () => {
    const app = buildApp("198.51.100.16");
    for (const overrides of [{ app_version: "0.0.9" }, { app_version: "0.1.0-beta.1" }]) {
      const res = await app.request(startUrl(overrides));
      expect(res.status).toBe(426);
      expect(res.headers.get("x-subkit-error")).toBe("desktop_app_outdated");
      expect(res.headers.get("location")).toBeNull();
      const html = await res.text();
      expect(html).toContain('data-testid="desktop-login-outdated"');
      expect(html).toContain("0.1.0");
    }
    const params = new URL(startUrl()).searchParams;
    params.delete("app_version");
    const silent = await app.request(`${ORIGIN}/v1/identity/desktop-login/start?${params}`);
    expect(silent.status).toBe(426);
    const silentHtml = await silent.text();
    expect(silentHtml).toContain("unknown");
    expect(silentHtml).toContain("0.1.0 or later");
  });

  test("refuses a plain challenge, a foreign redirect target and a missing device", async () => {
    const app = buildApp("198.51.100.11");
    for (const overrides of [
      { code_challenge_method: "plain" },
      { redirect_uri: "https://evil.example/callback" },
      { return_to: "https://evil.example" },
      { device_id: "" },
      { state: "short" },
    ]) {
      const res = await app.request(startUrl(overrides));
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  test("takes the development scheme outside production and refuses it in production", async () => {
    const dev = { redirect_uri: "subkit-dev://callback" };
    const accepted = await buildApp("198.51.100.13").request(startUrl(dev));
    expect(accepted.status).toBe(302);
    const location = new URL(accepted.headers.get("location") ?? "", ORIGIN);
    const signed = await verifyDesktopLoginRequest(location.searchParams.get("request") ?? "");
    expect(signed?.redirect_uri).toBe("subkit-dev://callback");
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const refused = await buildApp("198.51.100.14").request(startUrl(dev));
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { code: string }).code).toBe("invalid_redirect_uri");
      expect(refused.headers.get("location")).toBeNull();
      const plain = await buildApp("198.51.100.15").request(
        startUrl({ redirect_uri: "subkit://callback" }),
      );
      expect(plain.status).toBe(302);
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });

  test("is rate limited per client address", async () => {
    const app = buildApp("198.51.100.12");
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 31; attempt++)
      statuses.push((await app.request(startUrl())).status);
    expect(statuses.slice(0, 30).every((status) => status === 302)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe("GET /v1/identity/desktop-login/confirm", () => {
  test("sends a visitor without a browser session through the ordinary login and back", async () => {
    const request = await signDesktopLoginRequest({
      code_challenge: CHALLENGE,
      state: STATE,
      device_id: DEVICE_ID,
      device_label: "Laptop",
      app_version: "0.1.0",
    });
    const res = await buildApp("198.51.100.20").request(
      `${ORIGIN}/v1/identity/desktop-login/confirm?request=${encodeURIComponent(request)}`,
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/v1/identity/login/start");
    const loginState = await verifyLoginState(location.searchParams.get("login_state") ?? "");
    expect(loginState?.redirect_to).toBe(
      `/v1/identity/desktop-login/confirm?request=${encodeURIComponent(request)}`,
    );
    expect(String(loginState?.redirect_to).length).toBeLessThan(2048);
  });

  test("never issues a code or a callback redirect on a GET", async () => {
    const res = await buildApp("198.51.100.21").request(
      `${ORIGIN}/v1/identity/desktop-login/confirm?request=forged`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  test("an expired or forged request gets the desktop expiry page under the strict page policy", async () => {
    const res = await buildApp("198.51.100.22").request(
      `${ORIGIN}/v1/identity/desktop-login/confirm?request=forged`,
      { headers: { "accept-language": "de" } },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('data-testid="desktop-login-expired"');
    expect(html).toContain("Anmeldung abgelaufen");
    expect(html).toContain("SubKit · Desktop");
    expect(html).not.toContain("<script");
  });
});

describe("POST /v1/identity/desktop-login/confirm", () => {
  test("a cross-site form post is refused", async () => {
    const res = await buildApp("198.51.100.30").request(
      `${ORIGIN}/v1/identity/desktop-login/confirm`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "cross-site",
        },
        body: "decision=approve&request=x&csrf_token=y",
      },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });

  test("without a browser session nothing is approved", async () => {
    const request = await signDesktopLoginRequest({
      code_challenge: CHALLENGE,
      state: STATE,
      device_id: DEVICE_ID,
      device_label: "Laptop",
      app_version: "0.1.0",
    });
    const res = await buildApp("198.51.100.31").request(
      `${ORIGIN}/v1/identity/desktop-login/confirm`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ decision: "approve", request, csrf_token: "y" }).toString(),
      },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toStartWith("/v1/identity/desktop-login/confirm?request=");
  });
});

describe("POST /v1/identity/desktop-session", () => {
  const body = { code: CODE, code_verifier: VERIFIER, app_version: "0.1.0" };

  test("an app below the minimum version is refused with a clear code before the code is looked at", async () => {
    const app = buildApp("198.51.100.44");
    for (const outdated of [
      { code: CODE, code_verifier: VERIFIER },
      { code: CODE, code_verifier: VERIFIER, app_version: "0.0.1" },
    ]) {
      const res = await exchange(app, { "content-type": "application/json" }, outdated);
      expect(res.status).toBe(426);
      expect(((await res.json()) as { code: string }).code).toBe("desktop_app_outdated");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  test("is closed to web pages from another origin", async () => {
    const app = buildApp("198.51.100.40");
    for (const headers of [
      { "content-type": "application/json", origin: "https://evil.example" },
      { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      { "content-type": "application/json", "sec-fetch-site": "same-site" },
    ]) {
      const res = await exchange(app, headers, body);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("cross_origin_rejected");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("refuses a body a plain HTML form could send", async () => {
    const res = await exchange(
      buildApp("198.51.100.41"),
      { "content-type": "text/plain" },
      JSON.stringify(body),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("refuses a malformed code, a short verifier and unknown fields before any lookup", async () => {
    const app = buildApp("198.51.100.42");
    for (const invalid of [
      { code: "nope", code_verifier: VERIFIER },
      { code: CODE, code_verifier: "short" },
      { code: CODE },
      { ...body, installation_id: DEVICE_ID },
    ]) {
      const res = await exchange(app, { "content-type": "application/json" }, invalid);
      expect(res.status).toBe(400);
    }
  });

  test("is rate limited per client address", async () => {
    const app = buildApp("198.51.100.43");
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt++)
      statuses.push(
        (await exchange(app, { "content-type": "application/json" }, { code: "nope" })).status,
      );
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("desktop sign-in confirmation page", () => {
  const confirm = (overrides: Partial<Parameters<typeof renderDesktopLoginConfirm>[0]> = {}) =>
    renderDesktopLoginConfirm({
      deviceLabel: "Laptop",
      tenantName: "Acme",
      userEmail: "mike@example.test",
      requestToken: "request-token",
      csrfToken: "csrf-token",
      appVersion: "0.1.0",
      look: { locale: "en", scheme: null },
      ...overrides,
    });

  test("names the device, the workspace and the signed-in person, escaped in text and attributes", () => {
    const html = confirm({
      deviceLabel: '<img src=x onerror="alert(1)">',
      tenantName: 'Acme & "Co"',
    });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('onerror="alert');
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("Acme &amp; &quot;Co&quot;");
    expect(html).toContain("mike@example.test");
    expect(html).not.toContain("subkit://");
    expect(html).not.toContain("<script");
  });

  test("keeps the form contract: one post target, hidden tokens, deny before approve", () => {
    const html = confirm();
    expect(html).toContain(
      '<form method="POST" action="/v1/identity/desktop-login/confirm" data-testid="desktop-login-confirm">',
    );
    expect(html).toContain('<input type="hidden" name="request" value="request-token">');
    expect(html).toContain('<input type="hidden" name="csrf_token" value="csrf-token">');
    expect(html.indexOf('value="deny"')).toBeGreaterThan(0);
    expect(html.indexOf('value="deny"')).toBeLessThan(html.indexOf('value="approve"'));
    expect(html.split("request-token").length - 1).toBe(1);
    expect(html.split("csrf-token").length - 1).toBe(1);
  });

  test("shows each fact once: device and workspace in the graphic, one help line, details collapsed", () => {
    const html = confirm({ deviceLabel: "Studio Mac", tenantName: "Acme" });
    expect(html).toContain('data-testid="desktop-login-graphic"');
    const text = html.replace(/<[^>]+>/g, " ");
    expect(text.split("Studio Mac").length - 1).toBe(1);
    expect(text.split("Acme").length - 1).toBe(1);
    expect(html.match(/<p class="muted">/g)?.length).toBe(1);
    expect(html).toContain('<details class="dl-details"');
    expect(html).not.toContain('<details class="dl-details" open');
  });

  test("speaks German with the informal address", () => {
    const html = confirm({ look: { locale: "de", scheme: null } });
    expect(html).toContain("Bei SubKit Desktop anmelden");
    expect(html).toContain("wenn du die Anmeldung gerade selbst");
    expect(html).toContain("Arbeitsbereich");
    expect(html).not.toMatch(/\b(Sie|Ihre?)\b/);
  });

  test("leaves the shared auth style untouched and adds its own rules separately", () => {
    const html = confirm({ look: { locale: "en", scheme: "dark" } });
    expect(html).toContain('<html lang="en" class="dark">');
    const styles = html.match(/<style>[\s\S]*?<\/style>/g) ?? [];
    expect(styles).toHaveLength(2);
    expect(styles[0]).toContain("/*mcp-auth:begin*/");
    expect(styles[1]).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe("desktop sign-in notice pages", () => {
  test("the update page compares the versions and keeps the browser open as a way out", () => {
    const html = renderDesktopAppOutdated({
      appVersion: "0.0.9",
      minVersion: "0.1.0",
      look: { locale: "de", scheme: null },
    });
    expect(html).toContain('data-testid="desktop-login-outdated"');
    expect(html).toContain('data-testid="desktop-login-versions"');
    expect(html).toContain("0.0.9");
    expect(html).toContain("ab 0.1.0");
    expect(html).toContain('href="/cockpit"');
    expect(html).toContain("desktop_app_outdated");
    expect(html).not.toContain("<script");
  });

  test("the update page escapes a version the app sent", () => {
    const html = renderDesktopAppOutdated({
      appVersion: "<b>9</b>",
      minVersion: "0.1.0",
      look: { locale: "en", scheme: null },
    });
    expect(html).not.toContain("<b>9</b>");
    expect(html).toContain("&lt;b&gt;9&lt;/b&gt;");
  });

  test("the expiry page tells the person to restart in the app, in both languages", () => {
    expect(renderDesktopLoginExpired({ locale: "en", scheme: null })).toContain(
      "Start the sign-in again in SubKit Desktop.",
    );
    expect(renderDesktopLoginExpired({ locale: "de", scheme: "light" })).toContain(
      "Starte die Anmeldung in SubKit Desktop neu.",
    );
  });
});
