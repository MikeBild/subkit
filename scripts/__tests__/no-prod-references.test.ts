import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const self = "scripts/__tests__/no-prod-references.test.ts";

function gitGrep(args: string[]): string[] {
  try {
    return execFileSync("git", ["grep", ...args], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    if (err.status === 1 && !err.stdout) return [];
    throw error;
  }
}

function trackedMatches(markers: string[], pattern: string): string[] {
  const files = gitGrep([
    "-lIF",
    ...markers.flatMap((marker) => ["-e", marker]),
    "--",
    ".",
    ":!bun.lock",
    `:!${self}`,
  ]);
  if (!files.length) return [];
  return gitGrep(["-IhoP", pattern, "--", ...files]);
}

function outside(values: string[], allowed: Set<string>): string[] {
  return [...new Set(values)].filter((value) => !allowed.has(value)).sort();
}

describe("no installation-specific references", () => {
  test("the operator's domains appear in no tracked file", () => {
    const needle = ["mikebild", "(dev|com)"].join("\\.");
    let hits = "";
    try {
      hits = execFileSync("git", ["grep", "-nIE", needle, "--", ".", `:!${self}`], {
        cwd: root,
        encoding: "utf8",
      });
    } catch (error) {
      const err = error as { status?: number; stdout?: string };
      if (err.status === 1 && !err.stdout) return;
      throw error;
    }
    expect(hits, `installation-specific domain reference(s) found:\n${hits}`).toBe("");
  });

  test("AppSync endpoints in tracked files use synthetic API ids", () => {
    const allowed = new Set([
      "abc",
      "abc123def456",
      "bearertest",
      "exampleapi0000000000000000",
      "sigv4test",
      "x",
    ]);
    const ids = trackedMatches([".appsync-api."], "\\b[a-z0-9]+(?=\\.appsync-api\\.)");
    expect(outside(ids, allowed)).toEqual([]);
  });

  test("Google Cloud project numbers in tracked files are synthetic", () => {
    const allowed = new Set(["123456789012"]);
    const numbers = trackedMatches(
      [".apps.googleusercontent.com", "project ", "project=", "projects/"],
      "\\d{6,}(?=-[a-z0-9]+\\.apps\\.googleusercontent\\.com)|\\bproject(?:s/| |=)\\K\\d{6,}",
    );
    expect(outside(numbers, allowed)).toEqual([]);
  });
});
