// subkit.config.example.json must load cleanly through loadConfig().
// The committed example is the canonical operator template — if it
// fails Zod validation or trips the database.url-required guard, we
// ship documentation that points operators at a broken file. The
// drift gate at `bun run check:config-example-drift` keeps the file
// in sync with the schema; this test additionally proves the file
// boots through the full loader path.

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

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
    // Copy the committed example into a tmpdir so the loader's
    // potential first-boot session-secret persist doesn't mutate the
    // tracked file.
    const target = join(dir, "subkit.config.json");
    copyFileSync(EXAMPLE_PATH, target);

    await loadConfig({
      env: { NODE_ENV: "test" },
      configPathOverride: target,
    });
    const cfg = getConfig();
    // The example pre-fills database.url with a placeholder DSN so a
    // copy-paste keeps the file valid — the loader must accept it.
    expect(cfg.database.url).toContain("postgresql://");
    // Sane defaults survive the round-trip.
    expect(cfg.server.port).toBe(3000);
    expect(cfg.log.level).toBe("info");
    expect(cfg.log.format).toBe("ndjson");
  });
});
