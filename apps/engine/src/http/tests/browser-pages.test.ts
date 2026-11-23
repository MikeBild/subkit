import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BROWSER_PAGE_ROUTES, isBrowserNavigation, isBrowserPageRoute } from "../browser-pages.ts";
import { buildDefaultRegistry, createApp } from "../server.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("browser-pages");
});

afterAll(async () => {
  await ctx.cleanup();
});

function normalize(path: string): string {
  return path
    .split("/")
    .map((seg) => (seg.startsWith(":") || /^\{.+\}$/.test(seg) ? "{param}" : seg))
    .join("/");
}

const registryPairs = new Set(BROWSER_PAGE_ROUTES.map((r) => `${r.method} ${normalize(r.path)}`));

type OpenApiOperation = { responses?: Record<string, { content?: Record<string, unknown> }> };

describe("browser page registry", () => {
  test("every /v1 operation that answers with an HTML page is registered", async () => {
    const res = await fetch(`${ctx.baseUrl}/openapi.json`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, Record<string, OpenApiOperation>> };
    const htmlPairs: string[] = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      if (!path.startsWith("/v1/")) continue;
      for (const [method, operation] of Object.entries(methods)) {
        const html = Object.values(operation.responses ?? {}).some(
          (response) => response.content?.["text/html"] !== undefined,
        );
        if (html) htmlPairs.push(`${method.toUpperCase()} ${normalize(path)}`);
      }
    }
    expect(htmlPairs.length).toBeGreaterThan(5);
    const missing = htmlPairs.filter((pair) => !registryPairs.has(pair)).sort();
    expect(
      missing,
      "a /v1 route renders an HTML page but is missing from BROWSER_PAGE_ROUTES in http/browser-pages.ts",
    ).toEqual([]);
  });

  test("every registered page is a real route", () => {
    const app = createApp({ db: ctx.db, registry: buildDefaultRegistry(ctx.db) });
    const routes = new Set(
      app.routes
        .filter((route) => route.method !== "ALL")
        .map((route) => `${route.method.toUpperCase()} ${normalize(route.path)}`),
    );
    const stale = [...registryPairs].filter((pair) => !routes.has(pair)).sort();
    expect(stale, "BROWSER_PAGE_ROUTES names a route that no longer exists").toEqual([]);
  });

  test("matches page paths by method and parameter segment only", () => {
    expect(isBrowserPageRoute("GET", "/v1/connectors/abc/credentials/setup")).toBe(true);
    expect(isBrowserPageRoute("HEAD", "/v1/identity/desktop-login/confirm")).toBe(true);
    expect(isBrowserPageRoute("POST", "/v1/connectors/abc/oauth/start")).toBe(false);
    expect(isBrowserPageRoute("GET", "/v1/connectors/abc/def/credentials/setup")).toBe(false);
    expect(isBrowserPageRoute("GET", "/v1/identity/desktop-login/confirm/extra")).toBe(false);
    expect(isBrowserPageRoute("POST", "/v1/identity/desktop-session")).toBe(false);
  });

  test("tells a browser navigation from an API call", () => {
    const h = (init: Record<string, string>) => new Headers(init);
    expect(isBrowserNavigation(h({ "sec-fetch-dest": "document" }))).toBe(true);
    expect(isBrowserNavigation(h({ "sec-fetch-dest": "empty", accept: "text/html" }))).toBe(false);
    expect(isBrowserNavigation(h({ "sec-fetch-mode": "navigate" }))).toBe(true);
    expect(isBrowserNavigation(h({ accept: "text/html,application/xhtml+xml" }))).toBe(true);
    expect(isBrowserNavigation(h({ accept: "application/json" }))).toBe(false);
    expect(isBrowserNavigation(h({}))).toBe(false);
  });
});
