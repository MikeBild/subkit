import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import type { AppEnv } from "../openapi.ts";
import { registerBotRoute } from "./bot.ts";

let configDirectory: string;

beforeAll(async () => {
  configDirectory = mkdtempSync(join(tmpdir(), "bot-route-"));
  _resetConfigForTests();
  await loadConfig({
    configPathOverride: join(configDirectory, "subkit.config.json"),
    env: { DATABASE_URL: "postgres://localhost/bot_fixture", NODE_ENV: "test" },
  });
  await setConfigKey("server.public_base_url", "https://engine.example.test", { force: true });
});

afterAll(() => {
  _resetConfigForTests();
  rmSync(configDirectory, { recursive: true, force: true });
});

async function get(headers: Record<string, string> = {}): Promise<Response> {
  const app = new OpenAPIHono<AppEnv>();
  registerBotRoute(app);
  return app.request("http://127.0.0.1/bot", { headers });
}

describe("GET /bot", () => {
  test("tells a crawler owner who runs it and how to block it, in Markdown", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain("User-agent: sk-web-scraper");
    expect(body).toContain("Disallow: /");
    expect(body).toContain("engine.example.test");
  });

  test("answers a browser with HTML", async () => {
    const res = await get({ accept: "text/html" });
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<h1>sk-web-scraper</h1>");
  });
});
