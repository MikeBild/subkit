// E2E tests for binary version output.
// Requires compiled binaries: bun run build:sk && bun run build:cli

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

const SK_BIN = "./dist/sk";
const SUBKIT_BIN = "./dist/subkit";
const SEMVER_OR_DEV = /^\d+\.\d+\.\d+(-\w+)?$/;

async function runBinary(path: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([path, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim();
}

describe("binary version output", () => {
  const skExists = existsSync(SK_BIN);
  const subkitExists = existsSync(SUBKIT_BIN);

  test("sk --version outputs a non-empty version string", async () => {
    if (!skExists) {
      console.log("  (skipped — dist/sk not built)");
      return;
    }
    const version = await runBinary(SK_BIN, ["--version"]);
    expect(version.length).toBeGreaterThan(0);
  });

  test("subkit --version outputs a non-empty version string", async () => {
    if (!subkitExists) {
      console.log("  (skipped — dist/subkit not built)");
      return;
    }
    const version = await runBinary(SUBKIT_BIN, ["--version"]);
    expect(version.length).toBeGreaterThan(0);
  });

  test("sk --version matches semver or 0.0.0-dev pattern", async () => {
    if (!skExists) {
      console.log("  (skipped — dist/sk not built)");
      return;
    }
    const version = await runBinary(SK_BIN, ["--version"]);
    expect(version).toMatch(SEMVER_OR_DEV);
  });

  test("subkit --version matches semver or 0.0.0-dev pattern", async () => {
    if (!subkitExists) {
      console.log("  (skipped — dist/subkit not built)");
      return;
    }
    const version = await runBinary(SUBKIT_BIN, ["--version"]);
    expect(version).toMatch(SEMVER_OR_DEV);
  });
});
