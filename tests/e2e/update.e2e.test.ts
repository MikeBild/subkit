import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

const SK_BIN = "./dist/sk";
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

  test("sk --version outputs a non-empty version string", async () => {
    if (!skExists) {
      console.log("  (skipped — dist/sk not built)");
      return;
    }
    const version = await runBinary(SK_BIN, ["--version"]);
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
});
