import { isAbsolute, relative } from "node:path";
import { validateMutationRunConfig, validateMutationThresholds } from "./mutation-floor.ts";
import { isCanonicalRepoPath, type MutationWaveShard } from "./mutation-wave.ts";

function shellArgument(value: string): string {
  if (value.includes("\0")) throw new Error("Mutation command argument contains a null byte");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildMutationShardConfig(input: {
  base: unknown;
  waveId: string;
  runId: string;
  manifestPath: string;
  repo?: string;
  shard: MutationWaveShard;
  workers: number;
}): Record<string, unknown> {
  const errors = [
    ...validateMutationThresholds(input.base),
    ...validateMutationRunConfig({ config: input.base, report: { config: input.base } }),
  ];
  if (errors.length > 0)
    throw new Error(`Unsafe base mutation configuration: ${errors.join("; ")}`);
  for (const id of [input.waveId, input.runId, input.shard.id])
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(id)) throw new Error("Invalid mutation run identity");
  if (!Number.isSafeInteger(input.workers) || input.workers < 1)
    throw new Error("Mutation shard workers must be a positive safe integer");
  if (!isAbsolute(input.manifestPath)) throw new Error("Mutation wave manifest must be absolute");
  let manifestArgument = shellArgument(input.manifestPath);
  if (input.repo !== undefined) {
    if (!isAbsolute(input.repo)) throw new Error("Mutation repository must be absolute");
    const local = relative(input.repo, input.manifestPath);
    if (!isCanonicalRepoPath(local)) throw new Error("Mutation manifest escapes repository");
    manifestArgument = `"\${SUBKIT_MUTATION_ORIGINAL_REPO:?}"/${shellArgument(local)}`;
  }
  if (
    input.shard.targets.length === 0 ||
    new Set(input.shard.targets).size !== input.shard.targets.length ||
    input.shard.targets.some((path) => !isCanonicalRepoPath(path) || /[*?[\]{}!]/.test(path))
  )
    throw new Error("Mutation shard requires unique literal target paths");
  const artifactRoot = `reports/mutation/runs/${input.waveId}/${input.runId}/${input.shard.id}`;
  return {
    ...(input.base as Record<string, unknown>),
    testRunner: "command",
    commandRunner: {
      command: `bun run apps/engine/scripts/run-core-tests.ts --shard-manifest ${manifestArgument} --shard ${shellArgument(input.shard.id)}`,
    },
    mutate: [...input.shard.targets],
    coverageAnalysis: "off",
    incremental: false,
    thresholds: { high: 100, low: 100, break: 100 },
    reporters: ["clear-text", "json"],
    jsonReporter: { fileName: `${artifactRoot}/mutation.json` },
    tempDirName: ".stryker-tmp",
    cleanTempDir: "always",
    concurrency: input.workers,
  };
}
