// Install-script generator — pure-template tests.
//
// The /install endpoint produces a POSIX shell script the operator
// pipes into bash. The script is generated per-request from the
// engine's running version + the inferred public base URL. These
// tests pin:
//
//   - The shebang and `set -euo pipefail` (script must abort on errors,
//     not silently install half a binary).
//   - Platform/arch detection covers darwin + linux × arm64 + x64.
//   - The asset URL points at the GitHub Release for the current tag.
//   - SHA256 verification refuses to install on mismatch.
//   - The closing message includes the next-step `sk profile login`
//     command with the engine URL pre-filled.

import { describe, expect, test } from "bun:test";
import { _internal } from "./install.ts";

const { buildScript } = _internal;

describe("install script template", () => {
  test("starts with a bash shebang", () => {
    const script = buildScript("3.0.0", "https://engine.example.com");
    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
  });

  test("aborts on errors (set -euo pipefail)", () => {
    const script = buildScript("3.0.0", "https://engine.example.com");
    expect(script).toContain("set -euo pipefail");
  });

  test("interpolates the engine version into the asset URL", () => {
    const script = buildScript("3.3.0", "https://engine.example.com");
    expect(script).toContain('VERSION="3.3.0"');
    // Release tags are `v<VERSION>` since v3.3.0 (the legacy
    // `subkit-v<VERSION>` prefix was retired). Hardcoding the old
    // scheme silently 404'd every operator install — the test pins
    // the new scheme + a negative check on the old prefix so a
    // future regression fails loudly.
    expect(script).toContain("releases/download/v${VERSION}");
    expect(script).not.toContain("releases/download/subkit-v");
  });

  test("interpolates the engine base URL into the next-step message", () => {
    const script = buildScript("3.0.0", "https://my.engine.test");
    expect(script).toContain('ENGINE_URL="https://my.engine.test"');
    // First-run path is `sk init`; already-bootstrapped engines use `sk
    // login`. The legacy `sk profile login` was never an actual
    // command — the CLI exposes `sk login` and `sk profile`
    // (set/use/list/...), with no `login` subcommand under `profile`.
    expect(script).toContain("sk init --engine-url");
    expect(script).toContain("sk login --engine-url");
    expect(script).not.toContain("sk profile login");
  });

  test("detects darwin + linux", () => {
    const script = buildScript("3.0.0", "https://engine.example.com");
    expect(script).toMatch(/Darwin\) os=darwin/);
    expect(script).toMatch(/Linux\)\s+os=linux/);
    expect(script).toContain("unsupported OS:");
  });

  test("detects arm64 + x64", () => {
    const script = buildScript("3.0.0", "https://engine.example.com");
    expect(script).toMatch(/arm64\|aarch64\) arch=arm64/);
    expect(script).toMatch(/x86_64\|amd64\)\s+arch=x64/);
    expect(script).toContain("unsupported arch:");
  });

  test("verifies SHA256 and refuses on mismatch", () => {
    const script = buildScript("3.0.0", "https://engine.example.com");
    expect(script).toContain("SHA256SUMS");
    expect(script).toContain("SHA256 mismatch");
    expect(script).toContain("refusing to install");
  });

  test("falls back between sha256sum and shasum (BSD vs GNU)", () => {
    const script = buildScript("3.0.0", "https://engine.example.com");
    expect(script).toContain("command -v sha256sum");
    expect(script).toContain("command -v shasum");
  });

  test("installs to ~/.subkit/bin/sk by default, overridable via SK_INSTALL_DIR", () => {
    const script = buildScript("3.0.0", "https://engine.example.com");
    // Strings deliberately use bash $-syntax. Built via String.fromCharCode
    // so biome's noTemplateCurlyInString lint doesn't flag them — the
    // characters are ${ }, the script content is unchanged.
    const D = String.fromCharCode(36); // $
    const L = String.fromCharCode(123); // {
    const R = String.fromCharCode(125); // }
    expect(script).toContain(
      `INSTALL_DIR="${D}${L}SK_INSTALL_DIR:-${D}${L}HOME${R}/.subkit/bin${R}"`,
    );
    expect(script).toContain(`mv "${D}${L}TMP${R}/${D}${L}ASSET${R}" "${D}${L}INSTALL_DIR${R}/sk"`);
  });

  test("points sk doctor as the verification step", () => {
    const script = buildScript("3.0.0", "https://engine.example.com");
    expect(script).toContain("sk doctor");
  });
});
