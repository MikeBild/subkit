import { describe, expect, test } from "bun:test";
import { BROWSER_PAGE_ROUTES } from "../browser-pages.ts";
import { ctx, login, setupBrowserMemberships } from "./memberships-fixtures.ts";

setupBrowserMemberships();

const SAMPLE_ID = "00000000-0000-4000-8000-000000000001";

describe("browser pages with a hosted browser session", () => {
  test("no registered page answers a signed-in navigation with the workspace-context refusal", async () => {
    const owner = await login("browser-pages-owner");
    const refused: string[] = [];
    for (const route of BROWSER_PAGE_ROUTES) {
      const url = `${ctx.baseUrl}${route.path.replace(/\{[^}]+\}/g, SAMPLE_ID)}`;
      const response = await fetch(url, {
        method: route.method,
        headers: {
          cookie: owner.cookie,
          accept: "text/html,application/xhtml+xml",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "same-origin",
          ...(route.method === "POST"
            ? { "content-type": "application/x-www-form-urlencoded" }
            : {}),
        },
        ...(route.method === "POST" ? { body: "" } : {}),
        redirect: "manual",
      });
      const body = await response.text();
      if (response.status === 409 || body.includes("tenant_context_changed"))
        refused.push(`${route.method} ${route.path}`);
    }
    expect(refused).toEqual([]);
  });

  test("an API call without the workspace header is still refused", async () => {
    const owner = await login("browser-pages-api");
    const response = await fetch(`${ctx.baseUrl}/v1/identity/whoami`, {
      headers: { cookie: owner.cookie, accept: "application/json" },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("tenant_context_changed");
  });
});
