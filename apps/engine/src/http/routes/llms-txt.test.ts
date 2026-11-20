import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { DocsBundleSchema } from "@shared/llms-index.ts";
import { _resetConfigForTests, loadConfig } from "../../config/loader.ts";
import { DOCS_IMAGES } from "../docs-images-embedded.ts";
import { type AppEnv, OPENAPI_INFO } from "../openapi.ts";
import { registerDocsImageRoutes } from "./docs-images.ts";
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
    expect(body.startsWith("# SubKit\n")).toBe(true);
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
    expect(body.startsWith("# SubKit\n")).toBe(true);
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
    expect(body.startsWith("# SubKit\n")).toBe(true);
    expect(body).toContain("<!-- Source: setup.md -->");
    expect(body.length).toBeGreaterThan(20_000);
  });
});

describe("GET /docs.json", () => {
  test("serves the embedded bundle with both locales as application/json", async () => {
    const res = await buildApp().request("/docs.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("x-sk-docs-version")).toBe(OPENAPI_INFO.version);
    const bundle = DocsBundleSchema.parse(await res.json());
    expect(bundle.locales).toEqual(["en", "de"]);
    expect(bundle.pages.length).toBeGreaterThan(0);
    expect(bundle.sections.map((s) => s.id)).toEqual(["start", "work", "operate", "reference"]);
    expect(new Set(bundle.pages.map((p) => p.section))).toEqual(
      new Set(["start", "work", "operate", "reference"]),
    );
    expect(bundle.pages[0]?.slug).toBe("intro");
    for (const page of bundle.pages) {
      expect(page.locales.en.body.length).toBeGreaterThan(0);
      expect(page.locales.de.body.length).toBeGreaterThan(0);
    }
  });

  test("matches the descriptor sha256 and keeps the version out of the body", async () => {
    const app = buildApp();
    const body = await (await app.request("/docs.json")).text();
    const descriptor = (await (
      await app.request("/.well-known/service-descriptor.json")
    ).json()) as {
      version: string;
      artifacts: { docs_json: { url: string; sha256: string } };
      capabilities: string[];
    };
    expect(descriptor.artifacts.docs_json.url).toBe(`${ORIGIN}/docs.json`);
    expect(descriptor.artifacts.docs_json.sha256).toBe(
      createHash("sha256").update(body).digest("hex"),
    );
    expect(descriptor.version).toBe(OPENAPI_INFO.version);
    expect(descriptor.capabilities).toContain("docs");
    expect(Object.keys(JSON.parse(body)).sort()).toEqual(["locales", "pages", "sections"]);
  });

  test("tells the desktop app its minimum version and where it signs in", async () => {
    const descriptor = (await (
      await buildApp().request("/.well-known/service-descriptor.json")
    ).json()) as {
      clients: {
        desktop: { min_version: string; login: Record<string, unknown>; feedback_path: string };
      };
    };
    expect(descriptor.clients.desktop.min_version).toBe("0.1.0");
    expect(descriptor.clients.desktop.feedback_path).toBe("/cockpit?feedback=1");
    expect(descriptor.clients.desktop.login).toEqual({
      start: "/v1/identity/desktop-login/start",
      session: "/v1/identity/desktop-session",
      callback: "subkit://callback",
      callbacks: ["subkit://callback", "subkit-dev://callback"],
      code_challenge_methods: ["S256"],
    });
  });

  test("a production engine lists only the production sign-in target", async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const descriptor = (await (
        await buildApp().request("/.well-known/service-descriptor.json")
      ).json()) as { clients: { desktop: { login: { callback: string; callbacks: string[] } } } };
      expect(descriptor.clients.desktop.login.callback).toBe("subkit://callback");
      expect(descriptor.clients.desktop.login.callbacks).toEqual(["subkit://callback"]);
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });

  test("documents /docs.json in the OpenAPI spec and leaves /docs to the API reference", async () => {
    const app = buildApp();
    const spec = app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "t", version: "0" },
    });
    expect(spec.paths?.["/docs.json"]?.get).toBeDefined();
    expect(spec.paths?.["/docs"]).toBeUndefined();
    expect((await app.request("/docs")).status).toBe(404);
  });

  test("keeps the llms drill-down and full corpus unchanged", async () => {
    const app = buildApp();
    const setup = await app.request("/llms/setup.md");
    expect(setup.status).toBe(200);
    expect(setup.headers.get("content-type")).toMatch(/^text\/markdown/);
    const full = await app.request("/llms-full.txt");
    expect((await full.text()).startsWith("# SubKit\n")).toBe(true);
  });

  test("serves every image the bundle references from the embedded set", async () => {
    const app = buildApp();
    registerDocsImageRoutes(app);
    const bundle = DocsBundleSchema.parse(await (await app.request("/docs.json")).json());
    const sources = bundle.pages.flatMap((page) =>
      Object.values(page.locales).flatMap((content) => content.images.map((image) => image.src)),
    );
    const full = await (await app.request("/llms-full.txt")).text();
    expect(full).not.toMatch(/!\[[^\]]*\]\(images\//);
    for (const src of sources) {
      expect(src).toStartWith("/docs-images/");
      const res = await app.request(src);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("immutable");
    }
    const embedded = Object.keys(DOCS_IMAGES);
    const referenced = new Set(sources.map((src) => src.replace(/^\/docs-images\/|\?.*$/g, "")));
    expect(embedded.filter((file) => !referenced.has(file))).toEqual([]);
  });
});
