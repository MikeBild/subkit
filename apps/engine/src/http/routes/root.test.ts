// The entry point, and the promise it makes.
//
// GET / lists what this engine hands out. A link there that 404s is worse than
// no entry point: it tells a newcomer the service is broken at the first thing
// they touch. So this test holds the list against the routes actually
// registered, and pins the two renderings.

import { describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { LLMS_PAGE_PATHS } from "@shared/llms-index.ts";
import type { AppEnv } from "../openapi.ts";
import { COMPOSE_YAML, registerComposeRoute } from "./compose.ts";
import { registerInstallSkillRoute } from "./install-skill.ts";
import { registerLlmsTxtRoutes } from "./llms-txt.ts";
import { ROOT_ENTRY_PATHS, registerRootRoute } from "./root.ts";

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const app = new OpenAPIHono<AppEnv>();
  registerRootRoute(app);
  registerComposeRoute(app);
  registerInstallSkillRoute(app);
  registerLlmsTxtRoutes(app);
  return app.request(`http://127.0.0.1${path}`, { headers });
}

describe("GET /", () => {
  test("answers a machine with Markdown", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain("# sk");
    // Absolute links, because the reader may be an agent that cannot resolve
    // a relative path against a URL it was handed as a bare string. The host
    // itself is whatever origin the engine resolves, so assert the shape.
    expect(body).toMatch(/\(https?:\/\/[^)]+\/llms\.txt\)/);
  });

  test("answers a browser with HTML", async () => {
    const res = await get("/", { accept: "text/html,application/xhtml+xml" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("<title>sk");
  });

  test("both renderings list the same entries", async () => {
    const markdown = await (await get("/")).text();
    const html = await (await get("/", { accept: "text/html" })).text();
    for (const path of ROOT_ENTRY_PATHS) {
      expect(markdown).toContain(path);
      expect(html).toContain(path);
    }
  });
});

describe("what the entry point promises", () => {
  test("every self-description path it lists is served here", async () => {
    // Only the routes this test file registers can answer; the rest
    // (/openapi.json, /docs, /cockpit, /health, /ready) belong to other
    // registrars and are covered by their own tests. This checks the ones
    // that travel with the binary as documentation.
    for (const path of ["/docker-compose.yml", "/install/skill", "/llms.txt", "/llms-full.txt"]) {
      expect(ROOT_ENTRY_PATHS).toContain(path);
      const res = await get(path);
      expect(res.status).toBe(200);
      expect((await res.text()).length).toBeGreaterThan(0);
    }
  });

  test("the Compose file it points at is the one embedded here", async () => {
    const served = await (await get("/docker-compose.yml")).text();
    expect(served).toBe(COMPOSE_YAML);
  });
});

describe("the self-description set", () => {
  test("the index lists exactly the generated pages, and each one resolves", async () => {
    const index = await (await get("/llms.txt")).text();
    for (const rel of LLMS_PAGE_PATHS) {
      expect(index).toContain(`/llms/${rel}`);
      const page = await get(`/llms/${rel}`);
      expect(page.status).toBe(200);
      expect((await page.text()).length).toBeGreaterThan(200);
    }
  });

  test("no served page links to a page the binary does not carry", async () => {
    // A comparison run on 2026-09-03 found twelve such links and read them as
    // breakage. Links to carried pages must still resolve; the rest are text.
    for (const rel of LLMS_PAGE_PATHS) {
      const body = await (await get(`/llms/${rel}`)).text();
      const links = [
        ...body.matchAll(/\]\(((?:\.\.\/|\.\/)?[A-Za-z0-9_./-]+\.md)(?:#[^)]*)?\)/g),
      ].map((m) => m[1] as string);
      for (const target of links) {
        const dir = rel.split("/").slice(0, -1).join("/");
        const resolved = new URL(target, `http://x/${dir}/`).pathname.replace(/^\//, "");
        const res = await get(`/llms/${resolved}`);
        expect(`${rel} -> ${target}: ${res.status}`).toBe(`${rel} -> ${target}: 200`);
      }
    }
  });

  test("a page outside the set is not carried", async () => {
    // The point of the set is that it is small. If everything resolved, the
    // binary would be carrying the whole documentation again.
    const res = await get("/llms/concepts/glossary.md");
    expect(res.status).toBe(404);
  });
});
