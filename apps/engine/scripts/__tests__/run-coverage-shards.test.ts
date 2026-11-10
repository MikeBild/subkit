import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { mutationTestInputs } from "../audit/mutation-inputs.ts";
import { digestWaveFiles } from "../audit/mutation-wave.ts";
import { selectDistributedCoverageBehaviorProof } from "../distributed-quality.ts";
import {
  collectCoverageShardUnion,
  coverageBehaviorProofDescriptor,
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

test("distributed selector uses the coordinator's behavior-only proof for a mixed shard", async () => {
  const fixture = frozenWaveFixture();
  try {
    const [direct, behavior, mocked] = fixture.tests;
    const targets = fixture.targets;
    writeFileSync(
      join(fixture.root, mocked!),
      `${readFileSync(join(fixture.root, mocked!), "utf8")}\n// mock.module(\n`,
    );
    const directTargetPath = join(fixture.root, direct!);
    const additionalImports = [targets[1]!, targets[2]!]
      .map((target, index) => {
        const module = relative(dirname(directTargetPath), join(fixture.root, target))
          .replace(/\.ts$/, "")
          .replace(/^([^./])/, "./$1");
        return `import { fixture as extra${index} } from "${module}"; void extra${index};`;
      })
      .join("\n");
    writeFileSync(
      directTargetPath,
      `${readFileSync(directTargetPath, "utf8")}\n${additionalImports}\n`,
    );
    fixture.wave.shards[0]!.tests = fixture.wave.shards[0]!.tests.map((test) => {
      if (test.path === direct) return { ...test, covers_targets: targets.slice(0, 3) };
      if (test.path === behavior) return { ...test, kind: "reverse_import" };
      if (test.path === mocked) return { ...test, kind: "direct" };
      return test;
    });
    fixture.wave.test_freeze_sha256 = digestWaveFiles(fixture.root, fixture.tests);
    fixture.wave.source_freeze_sha256 = digestWaveFiles(
      fixture.root,
      mutationTestInputs(fixture.root),
    );
    writeFileSync(fixture.manifestPath, JSON.stringify(fixture.wave));
    const shard = fixture.wave.shards[0]!;
    const descriptor = coverageBehaviorProofDescriptor({
      shard,
      usesModuleMock: (path) => path === mocked,
    });
    expect(descriptor.tests).toEqual([behavior, mocked].sort());
    const root = join(
      fixture.root,
      "reports/coverage/shards",
      fixture.wave.wave_id,
      "run",
      "behavior",
    );
    mkdirSync(root, { recursive: true });
    const proofPath = join(root, descriptor.filename);
    const produced = await executeCoverageBehaviorGroups({
      repo: fixture.root,
      manifestPath: fixture.manifestPath,
      runId: "run",
      artifactRoot: root,
    });
    expect(produced.get(shard.id)).toBe(proofPath);
    const proofBytes = readFileSync(proofPath, "utf8");
    await expect(
      executeCoverageWave({
        repo: fixture.root,
        manifestPath: fixture.manifestPath,
        timeoutMs: 1,
        runId: "run",
        outputRoot: dirname(root),
        behaviorReceipts: produced,
        shardIds: ["missing"],
      }),
    ).rejects.toThrow("unknown or empty shard selection");
    expect(readFileSync(proofPath, "utf8")).toBe(proofBytes);
    expect(
      selectDistributedCoverageBehaviorProof({
        repo: fixture.root,
        manifestPath: fixture.manifestPath,
        waveId: fixture.wave.wave_id,
        coverageRunId: "run",
        shardId: shard.id,
      }),
    ).toBe(proofPath);
    writeFileSync(proofPath, JSON.stringify({ wave_id: fixture.wave.wave_id, tests: [direct] }));
    expect(() =>
      selectDistributedCoverageBehaviorProof({
        repo: fixture.root,
        manifestPath: fixture.manifestPath,
        waveId: fixture.wave.wave_id,
        coverageRunId: "run",
        shardId: shard.id,
      }),
    ).toThrow("absent or misrouted");
    unlinkSync(proofPath);
    writeFileSync(
      join(root, "foreign-proof.json"),
      JSON.stringify({ wave_id: fixture.wave.wave_id, tests: descriptor.tests }),
    );
    expect(() =>
      selectDistributedCoverageBehaviorProof({
        repo: fixture.root,
        manifestPath: fixture.manifestPath,
        waveId: fixture.wave.wave_id,
        coverageRunId: "run",
        shardId: shard.id,
      }),
    ).toThrow("absent or misrouted");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("behavior proof descriptors bind the shard even when behavior scopes match", () => {
  const shared = {
    targets: ["apps/engine/src/example/core.ts"],
    tests: [
      { path: "consumer.test.ts", kind: "reverse_import", covers_targets: [] },
      {
        path: "docker.test.ts",
        kind: "reverse_import",
        covers_targets: [],
        execution: "external_runtime" as const,
      },
    ],
    resource_tags: [],
  };
  const a = coverageBehaviorProofDescriptor({
    shard: { ...shared, id: "a" },
    usesModuleMock: () => false,
  });
  const b = coverageBehaviorProofDescriptor({
    shard: { ...shared, id: "b" },
    usesModuleMock: () => false,
  });
  expect(a.tests).toEqual(["consumer.test.ts"]);
  expect(b.tests).toEqual(["consumer.test.ts"]);
  expect(a.filename).not.toBe(b.filename);
});
