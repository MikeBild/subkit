import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _defaultConfigPathForTests } from "../loader.ts";

let dirA: string;
let dirB: string;
let originalCwd: string;

beforeEach(() => {
  dirA = realpathSync(mkdtempSync(join(tmpdir(), "subkit-cfg-path-a-")));
  dirB = realpathSync(mkdtempSync(join(tmpdir(), "subkit-cfg-path-b-")));
  originalCwd = process.cwd();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

describe("defaultConfigPath precedence", () => {
  test("SUBKIT_CONFIG wins over every other signal", () => {
    const explicit = join(dirA, "explicit.config.json");
    expect(
      _defaultConfigPathForTests({
        NODE_ENV: "production",
        CONFIGURATION_DIRECTORY: dirB,
        SUBKIT_CONFIG: explicit,
      }),
    ).toBe(explicit);
  });

  test("CONFIGURATION_DIRECTORY wins over NODE_ENV=production", () => {
    expect(
      _defaultConfigPathForTests({
        NODE_ENV: "production",
        CONFIGURATION_DIRECTORY: dirB,
      }),
    ).toBe(join(dirB, "subkit.config.json"));
  });

  test("NODE_ENV=production falls back to /etc/subkit when no other signal set", () => {
    expect(
      _defaultConfigPathForTests({
        NODE_ENV: "production",
      }),
    ).toBe("/etc/subkit/subkit.config.json");
  });

  test("CWD fallback when no env signal is set", () => {
    process.chdir(dirA);
    expect(
      _defaultConfigPathForTests({
        NODE_ENV: "test",
      }),
    ).toBe(join(dirA, "subkit.config.json"));
  });
});
