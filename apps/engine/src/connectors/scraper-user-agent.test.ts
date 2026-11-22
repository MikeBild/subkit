import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@cli-core/version.ts";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../config/loader.ts";
import { SCRAPER_PROJECT_URL, scraperUserAgent } from "./scraper-user-agent.ts";

let configDirectory: string;

beforeAll(async () => {
  configDirectory = mkdtempSync(join(tmpdir(), "scraper-user-agent-"));
  _resetConfigForTests();
  await loadConfig({
    configPathOverride: join(configDirectory, "subkit.config.json"),
    env: { DATABASE_URL: "postgres://localhost/scraper_ua_fixture", NODE_ENV: "test" },
  });
});

afterAll(() => {
  _resetConfigForTests();
  rmSync(configDirectory, { recursive: true, force: true });
});

afterEach(async () => {
  await setConfigKey("connectors.web_scraper.runtime.user_agent", "", { force: true });
  await setConfigKey("server.public_base_url", "", { force: true });
});

describe("scraperUserAgent", () => {
  test("links the engine's public /bot page when a public base URL is set", async () => {
    await setConfigKey("server.public_base_url", "https://engine.example.test/", { force: true });
    expect(scraperUserAgent()).toBe(
      `subkit-web-scraper/${VERSION} (+https://engine.example.test/bot)`,
    );
  });

  test("falls back to the project URL without a public base URL", () => {
    expect(scraperUserAgent()).toBe(`subkit-web-scraper/${VERSION} (+${SCRAPER_PROJECT_URL})`);
  });

  test("a configured value and a connector override win in that order", async () => {
    await setConfigKey("connectors.web_scraper.runtime.user_agent", "acme-bot/2", { force: true });
    expect(scraperUserAgent()).toBe("acme-bot/2");
    expect(scraperUserAgent(undefined, "connector-bot/3")).toBe("connector-bot/3");
  });
});
