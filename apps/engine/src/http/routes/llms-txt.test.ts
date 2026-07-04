// llms-txt routes — unit tests via Hono's `app.request()`. No DB, no auth:
// the routes are public and serve the docs embedded at build time. Config IS
// loaded (zero-config boot, tmpdir) because the index re-renders with the
// engine's resolved origin (server.public_base_url, else forwarded headers).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { _resetConfigForTests, loadConfig } from "../../config/loader.ts";
import type { AppEnv } from "../openapi.ts";
import { registerLlmsTxtRoutes } from "./llms-txt.ts";

const ORIGIN = "https://docs.example.test";
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sk-llms-txt-"));
  const cfgPath = join(dir, "subkit.config.json");
  writeFileSync(cfgPath, JSON.stringify({ server: { public_base_url: ORIGIN } }));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://localhost/x", NODE_ENV: "test" },
    configPathOverride: cfgPath,
  });
});

afterAll(() => {
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

function buildApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  registerLlmsTxtRoutes(app);
  return app;
}

describe("GET /llms.txt", () => {
  test("serves the index as text/markdown with origin-resolved drill-down links", async () => {
    const res = await buildApp().request("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/markdown; charset=utf-?8$/i);
    const body = await res.text();
    expect(body).toContain("# sk Documentation");
    // `>` blockquote lede + full-text pointer at the configured origin.
    expect(body).toContain("\n> ");
    expect(body).toContain(`Full documentation in one file: ${ORIGIN}/llms-full.txt`);
    // Drill-down links resolve to the engine origin, not repo-relative paths.
    expect(body).toContain(`(${ORIGIN}/llms/concepts/connectors.md)`);
    // Optional section per the llmstxt.org spec.
    expect(body).toContain("## Optional");
  });
});

describe("GET /.well-known/llms.txt", () => {
  test("aliases the index", async () => {
    const res = await buildApp().request("/.well-known/llms.txt");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("# sk Documentation");
    expect(body).toContain(`(${ORIGIN}/llms/`);
  });
});

describe("GET /llms/{path}", () => {
  test("serves a single indexed page as text/markdown", async () => {
    const res = await buildApp().request("/llms/concepts/connectors.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/markdown; charset=utf-?8$/i);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    // The body is the page itself, not the index.
    expect(body).not.toContain("## Optional");
  });

  test("returns 404 for an unknown page", async () => {
    const res = await buildApp().request("/llms/nope.md");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("/llms.txt");
  });
});

describe("GET /llms-full.txt", () => {
  test("serves the full docs corpus as text/markdown", async () => {
    const res = await buildApp().request("/llms-full.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/markdown; charset=utf-?8$/i);
    const body = await res.text();
    expect(body).toContain("# sk Documentation — Full Text");
    expect(body).toContain("<!-- Source: docs/");
    expect(body.length).toBeGreaterThan(50_000);
  });
});
