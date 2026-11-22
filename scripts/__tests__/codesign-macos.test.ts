import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan } from "../lib/commands.ts";

const SCRIPT = join(import.meta.dir, "..", "codesign-macos.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runOn(os: string, extra: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "codesign-macos-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const calls = join(root, "calls");
  writeFileSync(calls, "");
  writeFileSync(join(bin, "uname"), `#!/bin/sh\necho '${os}'\n`, { mode: 0o755 });
  writeFileSync(join(bin, "codesign"), `#!/bin/sh\necho "$*" >> '${calls}'\n`, { mode: 0o755 });
  const binary = join(root, "engine");
  writeFileSync(binary, "binary");
  writeFileSync(join(root, "entitlements.plist"), "<plist/>");
  const args = extra.map((arg) => arg.replace("{root}", root));
  const result = spawnSync("sh", [SCRIPT, binary, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { ...result, calls: readFileSync(calls, "utf8") };
}

describe("codesign-macos.sh", () => {
  test("fails loudly on a non-macOS host", () => {
    const result = runOn("Linux");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("macOS");
    expect(result.calls).toBe("");
  });

  test("ad-hoc signs on macOS", () => {
    const result = runOn("Darwin");
    expect(result.status).toBe(0);
    expect(result.calls).toContain("--sign - --force");
  });

  test("signs with an identity under the hardened runtime and verifies", () => {
    const result = runOn("Darwin", [
      "Developer ID Application: Test (TEAM)",
      "{root}/entitlements.plist",
    ]);
    expect(result.status).toBe(0);
    const lines = result.calls.trim().split("\n");
    expect(lines[0]).toContain(
      "--force --sign Developer ID Application: Test (TEAM) --options runtime --timestamp --identifier dev.mikebild.subkit.engine --entitlements ",
    );
    expect(lines[0]).toContain("entitlements.plist");
    expect(lines[1]).toContain("--verify --strict");
    expect(result.calls).not.toContain("--sign - ");
  });

  test("signs with an identity and no entitlements when none are given", () => {
    const result = runOn("Darwin", ["Developer ID Application: Test (TEAM)"]);
    expect(result.status).toBe(0);
    expect(result.calls).toContain(
      "--options runtime --timestamp --identifier dev.mikebild.subkit.engine",
    );
    expect(result.calls).not.toContain("--entitlements");
  });

  test("refuses an entitlements file that does not exist", () => {
    const result = runOn("Darwin", [
      "Developer ID Application: Test (TEAM)",
      "{root}/missing.plist",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("entitlements");
    expect(result.calls).toBe("");
  });
});

describe("build commands", () => {
  for (const name of ["subkit", "engine"]) {
    test(`build ${name} only signs on a macOS host`, () => {
      const signs = (platform: string) => {
        const result = plan("build", [name, "--skip-deps"], { version: "1.2.3", platform });
        if (!result.ok) throw new Error(result.usage);
        return result.steps.filter((step) => step.argv.includes("scripts/codesign-macos.sh"));
      };
      expect(signs("linux")).toEqual([]);
      expect(signs("darwin").map((step) => step.argv)).toEqual([
        ["sh", "scripts/codesign-macos.sh", `dist/${name}`],
      ]);
    });
  }
});
