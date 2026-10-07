import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../openapi.ts";
import { buildDefaultRegistry, createApp } from "../server.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let app: OpenAPIHono<AppEnv>;

const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

beforeAll(async () => {
  ctx = await createHttpTestServer("browser-pages");
  app = createApp({
    db: ctx.db,
    registry: buildDefaultRegistry(ctx.db),
    rateLimit: { max: 10_000, windowMs: 60_000 },
  });
  app.get("/__throws", () => {
    throw new Error("an unexpected failure");
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("an address nobody serves", () => {
  test("a browser gets the designed page, in the cockpit's language and theme", async () => {
    const res = await fetch(`${ctx.baseUrl}/no/such/page`, {
      headers: { accept: BROWSER, cookie: "sk_locale=de; sk_theme=dark" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain('<html lang="de" class="dark">');
    expect(html).toContain("<title>SubKit Cockpit</title>");
    expect(html).toContain("Diese Seite gibt es nicht");
    expect(html).toContain('data-family-surface="not-found"');
    expect(html.match(/<a\s/g)?.length).toBe(1);
    expect(html).toContain('href="/cockpit"');
  });

  test("every other client keeps the plain answer it gets today", async () => {
    for (const accept of ["application/json", "*/*", ""]) {
      const res = await fetch(`${ctx.baseUrl}/no/such/page`, { headers: { accept } });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("404 Not Found");
    }
  });
});

describe("an unhandled failure", () => {
  test("a browser gets a page that names the request's reference", async () => {
    const res = await app.request("http://127.0.0.1/__throws", {
      headers: { accept: BROWSER, "accept-language": "en-US,en;q=0.9" },
    });
    expect(res.status).toBe(500);
    const html = await res.text();
    const trace = res.headers.get("x-trace-id") ?? "";
    expect(trace.length).toBeGreaterThan(0);
    expect(html).toContain("Something went wrong");
    expect(html).toContain(trace);
    expect(html).toContain('data-family-surface="fatal-error"');
    expect(html).not.toContain("an unexpected failure");
    expect(html.match(/<a\s/g)?.length).toBe(1);
  });

  test("an API client keeps the error envelope", async () => {
    const res = await app.request("http://127.0.0.1/__throws", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; trace_id: string | null };
    expect(body.code).toBe("internal_error");
    expect(body.trace_id).toBe(res.headers.get("x-trace-id"));
  });
});

describe("a cockpit sign-in that wants to leave the cockpit", () => {
  const url = () =>
    `${ctx.baseUrl}/v1/identity/cockpit-login?return_to=${encodeURIComponent("https://evil.example/")}`;

  test("a browser is told why and led back into the cockpit", async () => {
    const res = await fetch(url(), { headers: { accept: BROWSER, cookie: "sk_locale=de" } });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Dieser Anmeldelink ist ungültig");
    expect(html.match(/<a\s/g)?.length).toBe(1);
    expect(html).toContain('href="/cockpit"');
    expect(html).not.toContain("evil.example");
  });

  test("an API client keeps the error envelope", async () => {
    const res = await fetch(url(), { headers: { accept: "application/json" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_return_to");
  });
});

describe("the canonical spelling", () => {
  test("the API reference is SubKit's, with a language", async () => {
    const html = await (await fetch(`${ctx.baseUrl}/docs`)).text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>SubKit — API reference</title>");
  });
});
