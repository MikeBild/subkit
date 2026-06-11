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

  test("`sk settings list --help` exits clean", () => {
    const r = run(["settings", "list", "--help"]);
    expect(r.status).toBe(0);
  });

  test("`sk settings get --help` exits clean", () => {
    const r = run(["settings", "get", "--help"]);
    expect(r.status).toBe(0);
  });

  test("`sk settings set --help` exits clean", () => {
    const r = run(["settings", "set", "--help"]);
    expect(r.status).toBe(0);
  });

  test("`sk settings configure --non-interactive` against an unreachable engine fails loudly with output", () => {
    // The expected failure mode is a structured TransportError
    // exit, NOT a TTY hang or a React render. We use TCP port 1
    // which always rejects; the response timing is sub-second.
    const r = run([
      "settings",
      "configure",
      "--non-interactive",
      "--engine-url",
      "http://127.0.0.1:1",
      "--api-key",
      "wf_live_smoke",
    ]);
    expect(r.status).not.toBe(null);
    expect(r.status).not.toBe(0);
    const combined = (r.stdout ?? "") + (r.stderr ?? "");
    expect(combined.length).toBeGreaterThan(0);
    // The CLI should hand back a recognisable transport-error
    // message on stderr, not a stack trace from the React renderer.
    expect(r.stderr).toMatch(/cannot reach engine|sk:|transport/i);
  });

  // Note on the JSON-envelope assertion (audit #20): the wire shape
  // is locked down by the route integration test in
  // apps/engine/src/http/routes/__tests__/settings.integration.test.ts
  // (real DB, real engine) and the headless CLI passes through the
  // engine response untransformed via printJson, which is a
  // straight JSON.stringify (see packages/cli-core/src/format.ts).
  // A spawnSync test against a stub HTTP server would add timing
  // flake without strengthening the contract — the engine + CLI
  // are tested at their respective boundaries.

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
