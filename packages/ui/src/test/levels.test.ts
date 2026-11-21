import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");
const LEVELS = ["atoms", "molecules", "organisms", "templates"] as const;

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from\s*["']([^"']+)["']/g)].map((match) => match[1] ?? "");
}

function levelOf(specifier: string): number {
  const level = specifier.match(/^@ui\/([a-z]+)\//)?.[1] ?? "";
  return LEVELS.indexOf(level as (typeof LEVELS)[number]);
}

describe("packages/ui follows Atomic Design", () => {
  test("the source holds only the four levels plus hooks, lib, i18n, styles and tests", () => {
    const folders = readdirSync(SRC, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(folders).toEqual(
      [
        "atoms",
        "hooks",
        "i18n",
        "lib",
        "molecules",
        "organisms",
        "styles",
        "templates",
        "test",
      ].sort(),
    );
  });

  test("a level imports only its own level or a lower one", () => {
    const upward: string[] = [];
    LEVELS.forEach((level, rank) => {
      for (const file of readdirSync(join(SRC, level))) {
        for (const specifier of importsOf(join(SRC, level, file))) {
          if (levelOf(specifier) > rank) upward.push(`${level}/${file} -> ${specifier}`);
        }
      }
    });
    expect(upward).toEqual([]);
  });

  test("knows no product: no product name, service brand or domain object", () => {
    const TERMS = /subkit|gmail|stripe|jira|\bskills?\b|\bworkflows?\b|\bconnectors?\b/i;
    const hits = readdirSync(SRC, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(ts|tsx|css)$/.test(file) && !file.startsWith("test/"))
      .filter((file) => TERMS.test(readFileSync(join(SRC, file), "utf8")));
    expect(hits).toEqual([]);
  });

  test("lib and hooks import no component", () => {
    const leaks = ["lib", "hooks"].flatMap((folder) =>
      readdirSync(join(SRC, folder))
        .filter((file) => !file.includes(".test."))
        .flatMap((file) =>
          importsOf(join(SRC, folder, file))
            .filter((specifier) => levelOf(specifier) >= 0)
            .map((specifier) => `${folder}/${file} -> ${specifier}`),
        ),
    );
    expect(leaks).toEqual([]);
  });
});
