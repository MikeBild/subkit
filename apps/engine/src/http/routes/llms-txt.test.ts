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
    expect(body.startsWith("# sk\n")).toBe(true);
    expect(body).toContain("\n> ");
    expect(body).toContain(`All pages in one file: ${ORIGIN}/llms-full.txt`);
    expect(body).toContain(`(${ORIGIN}/llms/setup.md)`);
  });
});

describe("GET /.well-known/llms.txt", () => {
  test("aliases the index", async () => {
    const res = await buildApp().request("/.well-known/llms.txt");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.startsWith("# sk\n")).toBe(true);
    expect(body).toContain(`(${ORIGIN}/llms/`);
  });
});

describe("GET /llms/{path}", () => {
  test("serves a single indexed page as text/markdown", async () => {
    const res = await buildApp().request("/llms/cli.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/markdown; charset=utf-?8$/i);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("# sk CLI reference");
  });

  test("does not carry a page outside the set", async () => {
    const res = await buildApp().request("/llms/concepts/workflows.md");
    expect(res.status).toBe(404);
  });

  test("returns 404 for an unknown page", async () => {
    const res = await buildApp().request("/llms/nope.md");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("/llms.txt");
  });
});

describe("GET /llms-full.txt", () => {
  test("serves what the binary carries, in one fetch", async () => {
    const res = await buildApp().request("/llms-full.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/markdown; charset=utf-?8$/i);
    const body = await res.text();
    expect(body.startsWith("# sk\n")).toBe(true);
    expect(body).toContain("<!-- Source: setup.md -->");
    expect(body.length).toBeGreaterThan(20_000);
  });
});
