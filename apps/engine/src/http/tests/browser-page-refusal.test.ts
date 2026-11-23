import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { REFUSAL_COPY } from "../i18n/browser-refusal.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("browser-page-refusal");
});

afterAll(async () => {
  await ctx.cleanup();
});

const NAVIGATION = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
};

function startUrl(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    state: "state-0123456789abcdef",
    device_id: "7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
    device_label: "Test device",
    app_version: "12.1.3",
    ...overrides,
  });
  return `${ctx.baseUrl}/v1/identity/desktop-login/start?${params}`;
}

describe("refusals on browser pages", () => {
  test("a refused sign-in target is a localized page for the browser and JSON for an API client", async () => {
    const url = startUrl({ redirect_uri: "subkit-dev://callback" });
    const before = testEnv.NODE_ENV;
    testEnv.NODE_ENV = "production";
    let de: Response;
    let en: Response;
    let api: Response;
    try {
      de = await fetch(url, {
        headers: { ...NAVIGATION, "accept-language": "de-DE,de;q=0.9" },
        redirect: "manual",
      });
      en = await fetch(url, {
        headers: { ...NAVIGATION, "accept-language": "en-US" },
        redirect: "manual",
      });
      api = await fetch(url, { headers: { accept: "application/json" }, redirect: "manual" });
    } finally {
      if (before === undefined) delete testEnv.NODE_ENV;
      else testEnv.NODE_ENV = before;
    }
    expect(de.status).toBe(400);
    expect(de.headers.get("content-type")).toContain("text/html");
    const deHtml = await de.text();
    expect(deHtml).toContain(REFUSAL_COPY.de.target_refused.title);
    expect(deHtml).toContain('data-refusal-kind="target_refused"');
    expect(deHtml).toContain("invalid_redirect_uri");
    expect(deHtml).not.toContain('"code"');

    expect(await en.text()).toContain("This sign-in target is not accepted");

    expect(api.status).toBe(400);
    expect(((await api.json()) as { code: string }).code).toBe("invalid_redirect_uri");
  });

  test("a cross-site confirmation is a page that says nothing was changed", async () => {
    const response = await fetch(`${ctx.baseUrl}/v1/identity/desktop-login/confirm`, {
      method: "POST",
      headers: {
        ...NAVIGATION,
        "accept-language": "de",
        "sec-fetch-site": "cross-site",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "request=x&csrf_token=y&decision=approve",
      redirect: "manual",
    });
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain(REFUSAL_COPY.de.cross_site.title);
    expect(html).toContain(REFUSAL_COPY.de.cross_site.line(null));
    expect(html).toContain("csrf_rejected");
    expect(html).not.toContain('"code"');
  });

  test("a malformed page request is a generic page with its code, never raw JSON", async () => {
    const response = await fetch(startUrl({ redirect_uri: "https://evil.example/callback" }), {
      headers: { ...NAVIGATION, "accept-language": "en" },
      redirect: "manual",
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("This page could not be opened");
    expect(html).toContain('data-testid="page-cockpit-link"');
    expect(html).not.toContain('"code"');
  });

  test("too many sign-in starts give a reload page with the wait time, API clients keep JSON", async () => {
    let limited: Response | null = null;
    for (let attempt = 0; attempt < 40 && !limited; attempt++) {
      const response = await fetch(startUrl(), {
        headers: { ...NAVIGATION, "accept-language": "de" },
        redirect: "manual",
      });
      if (response.status === 429) limited = response;
      else await response.body?.cancel();
    }
    if (!limited) throw new Error("the start limiter never answered 429");
    expect(limited.headers.get("content-type")).toContain("text/html");
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    const html = await limited.text();
    expect(html).toContain("Zu viele Versuche");
    expect(html).toContain(`Warte ${limited.headers.get("retry-after")} Sekunden`);
    expect(html).toContain('data-testid="page-reload-link"');
    expect(html).toContain("Neu laden");
    expect(html).toContain("/v1/identity/desktop-login/start?");

    const api = await fetch(startUrl(), { redirect: "manual" });
    expect(api.status).toBe(429);
    expect(api.headers.get("content-type")).toContain("application/json");
    expect(((await api.json()) as { code: string }).code).toBe("rate_limit_exceeded");
  });

  test("API routes outside the page registry keep JSON even for a browser navigation", async () => {
    const response = await fetch(`${ctx.baseUrl}/v1/workflows`, { headers: NAVIGATION });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
