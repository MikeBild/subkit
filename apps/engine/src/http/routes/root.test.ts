import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { LLMS_PAGE_PATHS } from "@shared/llms-index.ts";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { createDbFromUrl } from "../../db/client.ts";
import type { AppEnv } from "../openapi.ts";
import { createApp } from "../server.ts";
import { COMPOSE_YAML, registerComposeRoute } from "./compose.ts";
import { registerInstallSkillRoute } from "./install-skill.ts";
import { registerLlmsTxtRoutes } from "./llms-txt.ts";
import { cockpitLocation, ROOT_ENTRY_PATHS, registerRootRoute } from "./root.ts";

const offlineDb = createDbFromUrl("postgres://localhost/offline").db;

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

async function get(
  path: string,
  headers: Record<string, string> = {},
  options: { cockpitAvailable?: boolean } = {},
): Promise<Response> {
  const app = new OpenAPIHono<AppEnv>();
  registerRootRoute(app, { cockpitAvailable: () => options.cockpitAvailable ?? true });
  registerComposeRoute(app);
  registerInstallSkillRoute(app);
  registerLlmsTxtRoutes(app);
  return app.request(`http://127.0.0.1${path}`, { headers });
}

const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

describe("GET /", () => {
  test("a browser that opens the address lands in the Cockpit", async () => {
    const browser = await get("/", { accept: BROWSER_ACCEPT, "sec-fetch-mode": "navigate" });
    expect(browser.status).toBe(302);
    expect(browser.headers.get("location")).toBe("/cockpit");
    expect(browser.headers.get("cache-control")).toBe("no-store");
    expect(browser.headers.get("vary")).toBe("Accept, Sec-Fetch-Mode");
    expect((await get("/", { accept: "text/html" })).status).toBe(302);
    expect((await get("/", { "sec-fetch-mode": "navigate" })).status).toBe(302);
  });

  test("the redirect target never comes from the request", async () => {
    const browser = await get("/?next=https://external.example.test&return_to=//evil.test", {
      accept: "text/html",
      host: "external.example.test",
      "x-forwarded-host": "external.example.test",
      "x-forwarded-proto": "https",
      "x-forwarded-prefix": "/evil",
    });
    expect(browser.status).toBe(302);
    expect(browser.headers.get("location")).toBe("/cockpit");
  });

  test("the redirect keeps the base path of the configured public address", async () => {
    expect(cockpitLocation("")).toBe("/cockpit");
    expect(cockpitLocation("https://engine.example.test")).toBe("/cockpit");
    expect(cockpitLocation("https://engine.example.test/")).toBe("/cockpit");
    expect(cockpitLocation("https://example.test/subkit/")).toBe("/subkit/cockpit");
    expect(cockpitLocation("not a url")).toBe("/cockpit");
    await setConfigKey("server.public_base_url", "https://example.test/subkit", { force: true });
    try {
      const browser = await get("/", { accept: "text/html", "x-forwarded-host": "evil.test" });
      expect(browser.headers.get("location")).toBe("/subkit/cockpit");
    } finally {
      await setConfigKey("server.public_base_url", "", { force: true });
    }
  });

  test("agents and command-line clients keep the Markdown entry point", async () => {
    for (const headers of [
      {},
      { accept: "*/*" },
      { accept: "text/markdown" },
      { accept: "text/markdown, text/plain" },
      { accept: "text/markdown", "sec-fetch-mode": "navigate" },
    ] as Record<string, string>[]) {
      const agent = await get("/", headers);
      expect(agent.status).toBe(200);
      expect(agent.headers.get("content-type")).toContain("text/markdown");
      expect(agent.headers.get("vary")).toBe("Accept, Sec-Fetch-Mode");
    }
    for (const path of [
      "/llms.txt",
      "/.well-known/llms.txt",
      "/.well-known/service-descriptor.json",
    ])
      expect((await get(path, { accept: BROWSER_ACCEPT })).status).toBe(200);
  });

  test("a client that ranks Markdown above HTML keeps the HTML index it gets today", async () => {
    const res = await get("/", { accept: "text/markdown, text/html" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("with the redirect turned off a browser gets the HTML index", async () => {
    await setConfigKey("server.root_redirect_to_cockpit", false, { force: true });
    try {
      const res = await get("/", { accept: BROWSER_ACCEPT, "sec-fetch-mode": "navigate" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("<h1>SubKit</h1>");
    } finally {
      await setConfigKey("server.root_redirect_to_cockpit", true, { force: true });
    }
  });

  test("without a Cockpit bundle a browser gets the HTML index instead of a dead end", async () => {
    const res = await get("/", { accept: BROWSER_ACCEPT }, { cockpitAvailable: false });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("answers a machine with Markdown", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain("# subkit");
    expect(body).toMatch(/\(https?:\/\/[^)]+\/llms\.txt\)/);
  });

  test("the engine index stays at /engine, as HTML for a browser", async () => {
    const res = await get("/engine", {
      accept: "text/html,application/xhtml+xml",
      "sec-fetch-mode": "navigate",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain('<html lang="en">');
    expect(body).toContain("<title>SubKit — ");
    expect(body).toContain("<h1>SubKit</h1>");
    expect(body).not.toMatch(/<title>(subkit|subkit)\b/);
  });

  test("both renderings list the same entries", async () => {
    const markdown = await (await get("/")).text();
    const html = await (await get("/engine", { accept: "text/html" })).text();
    expect(await (await get("/engine")).text()).toBe(markdown);
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
    const app = createApp({ db: offlineDb, rateLimit: { max: 10_000, windowMs: 60_000 } });
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
    expect(index).toContain(
      "[Use SubKit from a coding agent](http://127.0.0.1/llms/coding-agents.md)",
    );
    const page = await (await get("/llms/coding-agents.md")).text();
    expect(page).toContain("subkit agent init --domains <category>");
    expect(page).toContain("`--domains <category>[,<category>]`");
    expect(page).toContain("In the repository, run `subkit status`.");
    expect(page).toContain("Run `subkit agent briefing --json`.");
    expect(page).toContain("Without `.subkit/agent.json`, the hooks match the folder name");
    expect(page).toContain("check that the SubKit hooks are active");
    expect(page).toContain("Trust new or changed SubKit hooks.");
    expect(page).toContain("`/hooks` in Codex shows the SubKit hooks as disabled");
  });

  test("no served page links to a page the binary does not carry", async () => {
    for (const rel of LLMS_PAGE_PATHS) {
      const body = await (await get(`/llms/${rel}`)).text();
      const links = [
        ...body.matchAll(/\]\(((?:\.\.\/|\.\/)?[A-Za-z0-9_./-]+\.md)(?:#[^)]*)?\)/g),
      ].map((m) => m[1] as string);
      for (const target of links) {
        const dir = rel.split("/").slice(0, -1).join("/");
        const resolved = new URL(target, `http://x/${dir ? `${dir}/` : ""}`).pathname.slice(1);
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
