import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, getConfig, loadConfig } from "../loader.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");
const EXAMPLE_PATH = join(REPO_ROOT, "subkit.config.example.json");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sk-cfg-example-"));
  _resetConfigForTests();
});

afterEach(() => {
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("subkit.config.example.json", () => {
  test("loads through loadConfig() without throwing", async () => {
    const target = join(dir, "subkit.config.json");
    copyFileSync(EXAMPLE_PATH, target);

    await loadConfig({
      env: { NODE_ENV: "test" },
      configPathOverride: target,
    });
    const cfg = getConfig();
    expect(cfg.database.url).toContain("postgresql://");
    expect(cfg.server.port).toBe(3000);
    expect(cfg.log.level).toBe("info");
    expect(cfg.log.format).toBe("ndjson");
  });
});
