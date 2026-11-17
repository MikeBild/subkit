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
  expect(scripts.scripts["verify:gate:release"]).toBe(
    "bun run check:mutation:release && bun run verify:gate:static && bun run check:coverage-floor && bun run test:docker",
  );
  expect(scripts.scripts["check:mutation:release"]).toBe(
    "bun run scripts/release-mutation-evidence.ts check",
  );
  expect(scripts.scripts["test:mutation:release"]).toEndWith(
    "bun run scripts/release-mutation-evidence.ts run",
  );
  expect(scripts.scripts["verify:gate:release"]).not.toContain("quality-bundle");
  expect(scripts.scripts["verify:gate:release"]).toContain("bun run check:coverage-floor");
  expect(scripts.scripts["verify:gate:release"]).not.toContain("verify:quality");
});

test("tagging checks the mutation evidence before the paid check and never runs mutation itself", () => {
  const evidence = tagRelease.indexOf('execFileSync("bun", ["run", "check:mutation:release"]');
  const paid = tagRelease.indexOf('execFileSync("bun", ["run", "verify:llm-live"');
  const gate = tagRelease.indexOf('execFileSync("bun", ["run", "verify:gate:release"]');
  expect(evidence).toBeGreaterThan(-1);
  expect(paid).toBeGreaterThan(evidence);
  expect(gate).toBeGreaterThan(paid);
  expect(tagRelease).not.toContain('test:mutation:release"]');
  expect(tagRelease).not.toContain('execFileSync("bun", ["run", "verify:gate"],');
  expect(tagRelease).not.toContain("verify:quality:release-shards");
  expect(scripts.scripts["verify:quality:release-shards"]).toBe(
    "bun run apps/engine/scripts/verify-quality-release-shards.ts",
  );
});

test("quality CI runs the suite with global coverage once and keeps mutation out of the push path", () => {
  const job = qualityWorkflow.slice(qualityWorkflow.indexOf("  coverage:\n"));
  const install = job.indexOf("bun install --frozen-lockfile");
  const terminalTools = job.indexOf("sudo apt-get install -y expect");
  const embeddings = job.indexOf("bun scripts/fetch-embedding-assets.ts");
  const clipper = job.indexOf("bun run build:clipper");
  const cockpit = job.indexOf("bun run build:cockpit");
  const sk = job.indexOf("bun run build:sk");
  const coverage = job.indexOf("bun run check:coverage-floor");
  const evidence = job.indexOf("name: coverage-floor-evidence");
  expect(install).toBeGreaterThan(-1);
  expect(terminalTools).toBeGreaterThan(install);
  expect(embeddings).toBeGreaterThan(terminalTools);
  expect(clipper).toBeGreaterThan(embeddings);
  expect(cockpit).toBeGreaterThan(clipper);
  expect(sk).toBeGreaterThan(cockpit);
  expect(coverage).toBeGreaterThan(sk);
  expect(evidence).toBeGreaterThan(coverage);
  expect(qualityWorkflow).toContain("retention-days: 90");
  expect(qualityWorkflow).toContain("retention-days: 30");
  expect(qualityWorkflow).toContain("path: reports/coverage/");
  const jobs = qualityWorkflow.slice(qualityWorkflow.indexOf("\njobs:\n"));
  expect(jobs.match(/^ {2}[a-z-]+:$/gm)).toEqual(["  coverage:"]);
  expect(qualityWorkflow).not.toContain("matrix");
  expect(qualityWorkflow).not.toContain("distributed-quality.ts");
  expect(qualityWorkflow).not.toContain("stryker");
});
