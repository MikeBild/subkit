import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { LLMS_PAGE_PATHS } from "@shared/llms-index.ts";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import type { AppEnv } from "../openapi.ts";
import { createApp } from "../server.ts";
import { COMPOSE_YAML, registerComposeRoute } from "./compose.ts";
import { registerInstallSkillRoute } from "./install-skill.ts";
import { registerLlmsTxtRoutes } from "./llms-txt.ts";
import { ROOT_ENTRY_PATHS, registerRootRoute } from "./root.ts";

let configDirectory: string;

beforeAll(async () => {
  configDirectory = mkdtempSync(join(tmpdir(), "root-route-"));
  _resetConfigForTests();
  await loadConfig({
    configPathOverride: join(configDirectory, "subkit.config.json"),
    env: { DATABASE_URL: "postgres://localhost/root_fixture", NODE_ENV: "test" },
  });
});

afterAll(() => {
  _resetConfigForTests();
  rmSync(configDirectory, { recursive: true, force: true });
});

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const app = new OpenAPIHono<AppEnv>();
  registerRootRoute(app);
  registerComposeRoute(app);
  registerInstallSkillRoute(app);
  registerLlmsTxtRoutes(app);
  return app.request(`http://127.0.0.1${path}`, { headers });
}

describe("GET /", () => {
  test("an operator can redirect browsers to the Cockpit while agents keep the Markdown entry point", async () => {
    await setConfigKey("server.root_redirect_to_cockpit", true, { force: true });
    try {
      const browser = await get("/?next=https://external.example.test", {
        accept: "text/html",
        "x-forwarded-host": "external.example.test",
        "x-forwarded-proto": "https",
      });
      expect(browser.status).toBe(302);
      expect(browser.headers.get("location")).toBe("/cockpit");
      expect(browser.headers.get("cache-control")).toBe("no-store");
      for (const accept of ["text/markdown", "*/*"]) {
        const agent = await get("/", { accept });
        expect(agent.status).toBe(200);
        expect(agent.headers.get("content-type")).toContain("text/markdown");
      }
      expect((await get("/llms.txt")).status).toBe(200);
    } finally {
      await setConfigKey("server.root_redirect_to_cockpit", false, { force: true });
    }
    expect((await get("/")).status).toBe(200);
    expect((await get("/", { accept: "text/html" })).status).toBe(200);
  });

  test("answers a machine with Markdown", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain("# sk");
    expect(body).toMatch(/\(https?:\/\/[^)]+\/llms\.txt\)/);
  });

  test("answers a browser with HTML", async () => {
    const res = await get("/", { accept: "text/html,application/xhtml+xml" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain('<html lang="en">');
    expect(body).toContain("<title>SubKit — ");
    expect(body).toContain("<h1>SubKit</h1>");
    expect(body).not.toMatch(/<title>(sk|subkit)\b/);
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
    for (const path of ["/docker-compose.yml", "/install/skill", "/llms.txt", "/llms-full.txt"]) {
      expect(ROOT_ENTRY_PATHS).toContain(path);
      const res = await get(path);
      expect(res.status).toBe(200);
      expect((await res.text()).length).toBeGreaterThan(0);
    }
  });

  test("the full engine serves the documentation bundle to an anonymous caller", async () => {
    expect(ROOT_ENTRY_PATHS).toContain("/docs.json");
    const app = createApp({ rateLimit: { max: 10_000, windowMs: 60_000 } });
    const res = await app.request("http://127.0.0.1/docs.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const bundle = (await res.json()) as { locales: string[]; pages: unknown[] };
    expect(bundle.locales).toEqual(["en", "de"]);
    expect(bundle.pages.length).toBeGreaterThan(0);
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

  test("coding-agent docs explain setup, verification, and manual recognition boundaries", async () => {
    const index = await (await get("/llms.txt")).text();
    expect(index).toContain("[Use sk from a coding agent](http://127.0.0.1/llms/coding-agents.md)");
    const page = await (await get("/llms/coding-agents.md")).text();
    expect(page).toContain(
      "In each repository, run `sk agent init --domains <category>[,<category>]`",
    );
    expect(page).toContain("Run `sk status`, then `sk agent briefing --json`");
    expect(page).toContain("Hooks first read `.sk/agent.json` when present.");
    expect(page).toContain(
      "Codex hooks are enabled by default; no `config.toml` edit is normally needed.",
    );
    expect(page).toContain("Review and trust new or changed SubKit hooks in `/hooks`.");
    expect(page).toContain("inspect the effective feature setting and administrator policy");
  });

  test("no served page links to a page the binary does not carry", async () => {
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
    const res = await get("/llms/concepts/glossary.md");
    expect(res.status).toBe(404);
  });
});
