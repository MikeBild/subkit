import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "codesign-macos.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runOn(os: string) {
  const root = mkdtempSync(join(tmpdir(), "codesign-macos-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const calls = join(root, "calls");
  writeFileSync(calls, "");
  writeFileSync(join(bin, "uname"), `#!/bin/sh\necho '${os}'\n`, { mode: 0o755 });
  writeFileSync(join(bin, "codesign"), `#!/bin/sh\necho "$*" >> '${calls}'\n`, { mode: 0o755 });
  const binary = join(root, "sk");
  writeFileSync(binary, "binary");
  const result = spawnSync("sh", [SCRIPT, binary], {
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
});

describe("build scripts", () => {
  const scripts = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
  ).scripts as Record<string, string>;

  for (const name of ["build:sk", "build:engine"]) {
    test(`${name} only signs on a macOS host`, () => {
      expect(scripts[name]).toMatch(
        /\[ "\$\(uname\)" != Darwin \] \|\| sh scripts\/codesign-macos\.sh /,
      );
    });
  }
});
