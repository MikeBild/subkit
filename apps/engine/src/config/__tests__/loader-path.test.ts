// defaultConfigPath() precedence — guards the production drift mode
// where the engine binary, started by systemd, picked the wrong
// subkit.config.json because `NODE_ENV` was unset on the unit. Each
// test asserts one rung of the precedence ladder:
//
//   1. SUBKIT_CONFIG          — explicit override, wins unconditionally.
//   2. CONFIGURATION_DIRECTORY — systemd-set when `ConfigurationDirectory=`
//                                is on the unit; the canonical operator
//                                signal for "config lives here".
//   3. NODE_ENV=production    — hard-coded /etc/subkit fallback.
//   4. CWD                    — dev / test fallback.
//
// We use the exported _defaultConfigPathForTests helper so we exercise
// the resolution function directly without triggering loadConfig()'s
// side effects (file write of the auto-generated session secret).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _defaultConfigPathForTests } from "../loader.ts";

let dirA: string;
let dirB: string;
let originalCwd: string;

beforeEach(() => {
  // macOS resolves /var/folders → /private/var/folders via symlinks
  // and path.resolve preserves the realpath form once node:fs walks
  // it. Normalize both tmpdirs through realpathSync so test
  // assertions compare against the canonical form path.resolve()
  // will emit at runtime.
  dirA = realpathSync(mkdtempSync(join(tmpdir(), "sk-cfg-path-a-")));
  dirB = realpathSync(mkdtempSync(join(tmpdir(), "sk-cfg-path-b-")));
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
    // dirB acts as the systemd-managed /etc/subkit equivalent. The
    // loader must resolve to dirB/subkit.config.json — NOT the
    // hard-coded /etc/subkit/subkit.config.json that NODE_ENV alone
    // would pick.
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
