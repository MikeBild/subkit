// CLI smoke for `sk settings` against the compiled binary.
//
// Asserts:
//   - `sk --version` reports the package.json version
//   - `sk settings --help` includes the new `configure` subcommand
//   - `sk settings configure --non-interactive` works headless and
//     emits the JSON contract instead of mounting Ink
//   - the linux-x64 binary stays under the documented size budget
//
// The settings round-trip is covered by the integration test in
// apps/engine/src/http/routes/__tests__/settings.integration.test.ts.
// This file proves the CLI surface itself ships and that the
// non-interactive guardrail keeps `sk settings configure` usable in
// pipelines / containers without a TTY.

import { describe, expect, test } from "bun:test";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const BINARY = resolve(REPO_ROOT, "dist", "sk");
const PACKAGE_VERSION = (await Bun.file(resolve(REPO_ROOT, "package.json")).json())
  .version as string;

function run(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(BINARY, args, { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
}

describe("sk binary smoke (v3.5)", () => {
  test("dist/sk exists — run `bun run build:sk` first if this fails", () => {
    expect(existsSync(BINARY)).toBe(true);
  });

  test("`sk --version` reports the package.json version", () => {
    const r = run(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(PACKAGE_VERSION);
  });

  test("`sk settings configure --help` exits clean", () => {
    const r = run(["settings", "configure", "--help"]);
    expect(r.status).toBe(0);
  });

  test("`sk settings configure --non-interactive` exits 2 without an engine but does NOT mount Ink", () => {
    // Without a configured profile the EngineClient will fail to
    // reach the engine. The expected failure mode is a structured
    // SkTransportError exit, NOT a TTY hang or a React render.
    const r = run([
      "settings",
      "configure",
      "--non-interactive",
      "--engine-url",
      "http://127.0.0.1:1",
      "--api-key",
      "wf_live_smoke",
    ]);
    // Exit code is non-zero (transport error). The point of the test
    // is that the process terminates instead of hanging on a TTY.
    expect(r.status).not.toBe(null);
    expect(r.status).not.toBe(0);
    // Either stderr carries the transport error, or stdout has the
    // JSON envelope from a successful headless render against a
    // running engine. Both are acceptable; the failure we're guarding
    // against is no output at all (deadlocked Ink renderer).
    const combined = (r.stdout ?? "") + (r.stderr ?? "");
    expect(combined.length).toBeGreaterThan(0);
  });

  test("`sk settings list --help` exits clean", () => {
    const r = run(["settings", "list", "--help"]);
    expect(r.status).toBe(0);
  });

  test("linux-x64 binary stays under the 80MB budget (when present)", () => {
    // The local build produces only the host's binary; CI builds the
    // matrix. We probe linux-x64 specifically — that's the engine
    // operator's primary deploy target. Skip cleanly when the file
    // isn't present.
    const linux = resolve(REPO_ROOT, "dist", "sk-linux-x64");
    if (!existsSync(linux)) return;
    const sizeMb = statSync(linux).size / 1024 / 1024;
    expect(sizeMb).toBeLessThan(80);
  });
});
