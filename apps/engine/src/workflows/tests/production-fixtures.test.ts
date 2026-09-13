// Production-fixture schema-parse guard.
//
// Pre-fix the 6.2.6 deploy shipped a transform-language heuristic that
// broke `/v1/workflows` in production — the `daily-do-
// resources-email` workflow's JSONata block (12+ lines ending in `;`)
// tripped an over-broad regex and threw ZodError on every row load.
// Only TransformStepSchema unit tests existed; they used synthetic
// minimal inputs that never exercised real production shapes.
//
// This test closes that gap by:
//   1. Storing anonymised copies of every workflow that exists on the
//      production (apps/engine/src/workflows/tests/fixtures/).
//      UUIDs are scrubbed; the DAG shape (kinds, languages, expression
//      bodies, loop/transform/request topologies) is preserved verbatim.
//   2. Iterating every fixture and asserting WorkflowDefSchema.safeParse
//      succeeds. Any future schema change that breaks parsing of a real
//      production-shaped workflow fails LOUDLY here, not at deploy time.
//
// When a new workflow shape lands in production that isn't covered:
//   - Run: bun run scripts/dump-prod-workflow-fixtures.ts (a future
//     helper; for now, copy the DAG from the production database via psql, anonymise
//     UUIDs to `00000000-0000-0000-0000-000000000NNN`, and drop into
//     this directory).
//   - The new file is picked up automatically by the glob below.
//
// Anonymisation contract: every UUID in any string field gets replaced
// by `00000000-0000-0000-0000-000000000NNN` (deterministic per-DAG
// counter). Connector slugs, expression bodies, query/header values,
// retry policies, on_error settings are preserved verbatim. The schema
// does not care about UUID identity — it cares about shape.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

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

  // Loud failure if the fixture dir somehow ends up empty (CI ran in
  // a stale worktree, glob broken, etc.) — silent zero-test pass would
  // give a false confidence signal.
  test("fixture directory is non-empty (sanity)", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { slug, dag } of fixtures) {
    test(`fixture "${slug}" round-trips through WorkflowDefSchema`, () => {
      const result = WorkflowDefSchema.safeParse(dag);
      if (!result.success) {
        // Surface the FULL Zod error to the console so a regression is
        // immediately actionable — without this the failure message is
        // a single line that doesn't name the broken step.
        console.error(
          `fixture "${slug}" failed to parse:`,
          JSON.stringify(result.error.issues, null, 2),
        );
      }
      expect(result.success).toBe(true);
    });
  }
});
