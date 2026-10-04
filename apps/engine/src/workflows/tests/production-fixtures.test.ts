import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowDefSchema } from "../types.ts";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixtures(): Array<{ slug: string; dag: unknown }> {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    const slug = file.replace(/\.json$/, "");
    const dag = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8"));
    return { slug, dag };
  });
}

describe("WorkflowDefSchema parses every production workflow shape", () => {
  const fixtures = loadFixtures();

  test("fixture directory is non-empty (sanity)", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { slug, dag } of fixtures) {
    test(`fixture "${slug}" round-trips through WorkflowDefSchema`, () => {
      const result = WorkflowDefSchema.safeParse(dag);
      if (!result.success) {
        console.error(
          `fixture "${slug}" failed to parse:`,
          JSON.stringify(result.error.issues, null, 2),
        );
      }
      expect(result.success).toBe(true);
    });
  }
});
