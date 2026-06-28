// llms-txt routes — unit tests via Hono's `app.request()`. No DB, no auth:
// the route is public and serves the docs files embedded at build time, so
// the smaller surface keeps the test honest about what it does.

import { describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../openapi.ts";
import { registerLlmsTxtRoutes } from "./llms-txt.ts";

function buildApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  registerLlmsTxtRoutes(app);
  return app;
}

describe("GET /llms.txt", () => {
  test("serves the docs index as text/markdown, unauthenticated", async () => {
    const res = await buildApp().request("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/markdown; charset=utf-?8$/i);
    const body = await res.text();
    // Stable header line of the generated index.
    expect(body).toContain("# sk Documentation");
    expect(body.length).toBeGreaterThan(0);
  });
});

describe("GET /llms-full.txt", () => {
  test("serves the full docs corpus as text/markdown, unauthenticated", async () => {
    const res = await buildApp().request("/llms-full.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/markdown; charset=utf-?8$/i);
    const body = await res.text();
    expect(body).toContain("# sk Documentation — Full Text");
    // The full variant inlines page content with source markers; it must be
    // materially larger than the index.
    expect(body).toContain("<!-- Source: docs/");
    expect(body.length).toBeGreaterThan(50_000);
  });
});
