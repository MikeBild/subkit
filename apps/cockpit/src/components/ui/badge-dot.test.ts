import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [path] : [];
  });
}

test("no chip draws a second status dot as a glyph", () => {
  const offenders = sources(SRC).filter((file) =>
    /<span aria-hidden="true">\{[^{}]*"[●○]"[^{}]*\}<\/span>/.test(readFileSync(file, "utf8")),
  );
  expect(offenders.map((file) => file.slice(SRC.length + 1))).toEqual([]);
});
