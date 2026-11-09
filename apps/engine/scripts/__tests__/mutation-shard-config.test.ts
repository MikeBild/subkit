import { describe, expect, test } from "bun:test";
import { buildMutationShardConfig } from "../audit/mutation-shard-config.ts";

const input = {
  base: {
    testRunner: "command",
    commandRunner: { command: "bun run apps/engine/scripts/run-core-tests.ts" },
    coverageAnalysis: "off",
    incremental: false,
    thresholds: { high: 100, low: 100, break: 100 },
    concurrency: 8,
    ignorePatterns: ["/reports", "/.artifacts", "/.stryker-tmp*"],
  },
  waveId: "baseline",
  runId: "run-1",
  manifestPath: "/tmp/a space/manifest.json",
  shard: {
    id: "cli",
    targets: ["packages/cli-core/src/format-render.ts"],
    tests: [],
    consumers: [],
    resource_tags: [],
  },
  workers: 2,
};

describe("isolated mutation shard configuration", () => {
  test("keeps full nonincremental 100 percent gates with shared sandbox parent and isolated reports", () => {
    const before = structuredClone(input);
    const result = buildMutationShardConfig(input);
    expect(result).toMatchObject({
      concurrency: 2,
      incremental: false,
      coverageAnalysis: "off",
      thresholds: { high: 100, low: 100, break: 100 },
      mutate: input.shard.targets,
      ignorePatterns: input.base.ignorePatterns,
      tempDirName: ".stryker-tmp",
      jsonReporter: { fileName: "reports/mutation/runs/baseline/run-1/cli/mutation.json" },
    });
    expect(input).toEqual(before);
    const second = buildMutationShardConfig({ ...input, runId: "run-2" });
    expect(second.tempDirName).toBe(result.tempDirName);
    expect(second.jsonReporter).not.toEqual(result.jsonReporter);
  });

  test("quotes manifest filenames as literal shell arguments", () => {
    const result = buildMutationShardConfig({
      ...input,
      manifestPath: "/tmp/it's $(not-a-command)/wave.json",
    });
    expect(result.commandRunner).toEqual({
      command:
        "bun run apps/engine/scripts/run-core-tests.ts --shard-manifest '/tmp/it'\\''s $(not-a-command)/wave.json' --shard 'cli'",
    });
  });

  test("refuses weakened base settings rather than silently overwriting exclusions", () => {
    for (const patch of [
      { incremental: true },
      { thresholds: { high: 100, low: 100, break: 90 } },
      { ignoreStatic: true },
      { mutator: { excludedMutations: ["StringLiteral"] } },
      { commandRunner: { command: "true" } },
    ])
      expect(() =>
        buildMutationShardConfig({ ...input, base: { ...input.base, ...patch } }),
      ).toThrow("Unsafe");
  });

  test("rejects unsafe scope, paths and invalid budgets", () => {
    expect(() => buildMutationShardConfig({ ...input, runId: "../other" })).toThrow();
    expect(() => buildMutationShardConfig({ ...input, manifestPath: "relative.json" })).toThrow();
    expect(() => buildMutationShardConfig({ ...input, workers: 0 })).toThrow();
    for (const targets of [[], ["**/*.ts"], ["../outside.ts"], ["same.ts", "same.ts"]])
      expect(() =>
        buildMutationShardConfig({ ...input, shard: { ...input.shard, targets } }),
      ).toThrow();
  });
});

test("policy-bound mutation configs retain identical bytes across checkout roots", () => {
  const first = buildMutationShardConfig({
    ...input,
    repo: "/tmp/first",
    manifestPath: "/tmp/first/reports/wave.json",
  });
  const second = buildMutationShardConfig({
    ...input,
    repo: "/srv/second",
    manifestPath: "/srv/second/reports/wave.json",
  });
  expect(first).toEqual(second);
  expect(first.commandRunner).toEqual({
    command: `bun run apps/engine/scripts/run-core-tests.ts --shard-manifest "\${SUBKIT_MUTATION_ORIGINAL_REPO:?}"/'reports/wave.json' --shard 'cli'`,
  });
  expect(() =>
    buildMutationShardConfig({
      ...input,
      repo: "/tmp/repo",
      manifestPath: "/tmp/outside/wave.json",
    }),
  ).toThrow("escapes repository");
});
