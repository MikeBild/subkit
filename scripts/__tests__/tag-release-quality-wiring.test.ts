import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const tagRelease = readFileSync(join(root, "scripts/tag-release.ts"), "utf8");
const qualityWorkflow = readFileSync(join(root, ".github/workflows/quality.yml"), "utf8");

test("developer and release gates keep their distinct quality contracts", () => {
  expect(scripts.scripts["verify:gate:static"]).toContain("bun run test:determinism");
  expect(scripts.scripts["verify:gate:static"]).not.toContain("verify:quality");
  expect(scripts.scripts["verify:gate"]).toBe(
    "bun run verify:gate:static && bun run verify:quality",
  );
  expect(scripts.scripts["verify:gate:release"]).toContain(
    "scripts/verify-shard-quality-bundle.ts",
  );
  expect(scripts.scripts["verify:gate:release"]).toContain(
    "reports/quality-export/shards/quality-bundle.json",
  );
  expect(scripts.scripts["verify:gate:release"]).toContain("bun run check:coverage-floor");
  expect(scripts.scripts["verify:gate:release"]).not.toContain("verify:quality");
});

test("tagging invokes only the strict local shard-bundle release gate", () => {
  expect(tagRelease).toContain('execFileSync("bun", ["run", "verify:gate:release"]');
  expect(tagRelease).not.toContain('execFileSync("bun", ["run", "verify:gate"],');
  expect(tagRelease).toContain("verify:quality:release-shards");
});

test("quality CI preserves global coverage evidence before the canonical shard proof", () => {
  const coverage = qualityWorkflow.indexOf("bun run check:coverage-floor");
  const evidence = qualityWorkflow.indexOf("name: coverage-floor-evidence");
  const shards = qualityWorkflow.indexOf("bun run verify:quality:release-shards");
  expect(coverage).toBeGreaterThan(-1);
  expect(evidence).toBeGreaterThan(coverage);
  expect(shards).toBeGreaterThan(evidence);
  expect(qualityWorkflow).toContain("retention-days: 30");
  expect(qualityWorkflow).toContain("path: reports/coverage/");
});
