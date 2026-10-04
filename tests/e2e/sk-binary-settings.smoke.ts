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
    expect(r.stderr).toMatch(/cannot reach engine|sk:|transport/i);
  });

  test("linux-x64 binary stays under the 80MB budget (when present)", () => {
    const linux = resolve(REPO_ROOT, "dist", "sk-linux-x64");
    if (!existsSync(linux)) return;
    const sizeMb = statSync(linux).size / 1024 / 1024;
    expect(sizeMb).toBeLessThan(80);
  });
});
