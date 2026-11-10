import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectCoverageShardUnion,
  coverageShardConcurrency,
  executeCoverageBehaviorGroups,
  executeCoverageWave,
  relativeCoverageEvidencePath,
} from "../run-coverage-shards.ts";
import { frozenWaveFixture } from "./fixtures/frozen-wave.ts";

test("coverage distributed coordinator, shard executor, and collector APIs are exported", () => {
  expect(executeCoverageBehaviorGroups).toBeInstanceOf(Function);
  expect(executeCoverageWave).toBeInstanceOf(Function);
  expect(collectCoverageShardUnion).toBeInstanceOf(Function);
});

test("coverage shard evidence paths are confined to the repository", () => {
  expect(
    relativeCoverageEvidencePath(
      "/repo",
      "/repo/reports/coverage/shards/wave/run/coverage/latest.json",
    ),
  ).toBe("reports/coverage/shards/wave/run/coverage/latest.json");
  for (const path of ["/outside/latest.json", "/repo", "/repo/../outside/latest.json"])
    expect(() => relativeCoverageEvidencePath("/repo", path)).toThrow("escapes repository");
});

test("coverage concurrency honors assigned workers and serializes resource-tagged shards", () => {
  expect(coverageShardConcurrency(0, [])).toBe("1");
  expect(coverageShardConcurrency(3, [])).toBe("3");
  expect(coverageShardConcurrency(9, [])).toBe("4");
  expect(coverageShardConcurrency(3, ["postgres"])).toBe("1");
});

test("coverage collector rejects a missing shard artifact before reading native reports", () => {
  const fixture = frozenWaveFixture();
  const outputRoot = mkdtempSync(join(tmpdir(), "coverage-union-"));
  try {
    expect(() =>
      collectCoverageShardUnion({
        repo: fixture.root,
        manifestPath: fixture.manifestPath,
        runId: "run-coverage-test",
        shardRoots: new Map(),
        outputRoot,
      }),
    ).toThrow("missing shard root");
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
