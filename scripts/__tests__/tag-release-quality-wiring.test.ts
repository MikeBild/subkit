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

test("quality CI retains global coverage before the distributed coordinator, shard, and merge proof", () => {
  const coverage = qualityWorkflow.indexOf("bun run check:coverage-floor");
  const evidence = qualityWorkflow.indexOf("name: coverage-floor-evidence");
  const prepare = qualityWorkflow.indexOf("distributed-quality.ts prepare");
  const coordinatorArtifact = qualityWorkflow.indexOf("name: quality-coordinator");
  const shard = qualityWorkflow.indexOf("  shard:\n    needs: coordinator");
  const shardCoverage = qualityWorkflow.indexOf("distributed-quality.ts coverage");
  const shardMutation = qualityWorkflow.indexOf("distributed-quality.ts mutation");
  const shardArtifact = qualityWorkflow.indexOf(`name: quality-shard-\${{ matrix.shard }}`);
  const mergeJob = qualityWorkflow.indexOf(
    "  coverage-and-mutation:\n    needs: [coordinator, shard]",
  );
  const merge = qualityWorkflow.indexOf("distributed-quality.ts merge");
  const finalArtifact = qualityWorkflow.indexOf("name: quality-shard-evidence");
  expect(coverage).toBeGreaterThan(-1);
  expect(evidence).toBeGreaterThan(coverage);
  expect(prepare).toBeGreaterThan(evidence);
  expect(coordinatorArtifact).toBeGreaterThan(prepare);
  expect(shard).toBeGreaterThan(coordinatorArtifact);
  expect(shardCoverage).toBeGreaterThan(shard);
  expect(shardMutation).toBeGreaterThan(shardCoverage);
  expect(shardArtifact).toBeGreaterThan(shardMutation);
  expect(mergeJob).toBeGreaterThan(shardArtifact);
  expect(merge).toBeGreaterThan(mergeJob);
  expect(finalArtifact).toBeGreaterThan(merge);
  expect(qualityWorkflow).toContain("retention-days: 90");
  expect(qualityWorkflow).toContain("retention-days: 30");
  expect(qualityWorkflow).toContain("path: reports/coverage/");
});
