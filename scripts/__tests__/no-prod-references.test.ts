import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const self = "scripts/__tests__/no-prod-references.test.ts";
const publicProductDomains = new Set(["subkit.mikebild.dev", "subkit-cloud.mikebild.dev"]);
const operatorDomain =
  /(?<![a-z0-9.-])(?:[a-z0-9-]+\.)*mikebild\.(?:dev|com)(?:\.[a-z0-9-]+)*(?![a-z0-9.-])/gi;

function installationSpecificDomainLines(hits: string): string {
  return hits
    .split("\n")
    .filter((line) =>
      (line.match(operatorDomain) ?? []).some(
        (domain) => !publicProductDomains.has(domain.toLowerCase()),
      ),
    )
    .join("\n");
}

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
  test("allows only the exact public product domains", () => {
    const allowed = "public: https://subkit.mikebild.dev/kontakt";
    const cloud = "cloud: https://subkit-cloud.mikebild.dev/install";
    const cloudSuffix = "cloud suffix: https://subkit-cloud.mikebild.dev.evil";
    const cloudPrefix = "cloud prefix: https://ops.subkit-cloud.mikebild.dev";
    const root = "root: https://mikebild.dev";
    const privateSubdomain = "private: https://ops.mikebild.dev";
    const suffix = "suffix: https://subkit.mikebild.dev.evil";
    const mixed = "mixed: https://subkit.mikebild.dev/kontakt https://ops.mikebild.com";
    expect(
      installationSpecificDomainLines(
        [allowed, cloud, root, privateSubdomain, suffix, mixed, cloudSuffix, cloudPrefix].join(
          "\n",
        ),
      ),
    ).toBe([root, privateSubdomain, suffix, mixed, cloudSuffix, cloudPrefix].join("\n"));
  });

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
    const forbidden = installationSpecificDomainLines(hits);
    expect(forbidden, `installation-specific domain reference(s) found:\n${forbidden}`).toBe("");
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
