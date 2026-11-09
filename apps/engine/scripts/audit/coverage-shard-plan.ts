export interface CoverageShardTest {
  path: string;
  kind: string;
  covers_targets: readonly string[];
  execution?: "in_process" | "external_runtime";
}

export interface CoverageShardExecutionPlan {
  coverageTests: string[];
  coverageGroups: Array<{ target: string; tests: string[] }>;
  behaviorOnlyTests: string[];
  externalRuntimeTests: string[];
  directTargetsByTest: Map<string, string[]>;
  errors: string[];
}

export interface CoverageBehaviorGroup {
  key: string;
  resource_tags: string[];
  tests: string[];
  shards: string[];
}

export function planCoverageShardExecution(input: {
  targets: readonly string[];
  tests: readonly CoverageShardTest[];
  usesModuleMock: (test: string) => boolean;
}): CoverageShardExecutionPlan {
  const directTargetsByTest = new Map<string, string[]>();
  const errors: string[] = [];
  const externalRuntimeTests = input.tests
    .filter((test) => test.execution === "external_runtime")
    .map((test) => test.path)
    .sort();
  for (const test of input.tests) {
    if (test.execution === "external_runtime") continue;
    if (test.kind !== "direct" || input.usesModuleMock(test.path)) continue;
    const targets = directTargetsByTest.get(test.path) ?? [];
    for (const target of test.covers_targets)
      if (input.targets.includes(target)) targets.push(target);
    directTargetsByTest.set(test.path, [...new Set(targets)].sort());
  }
  const coverageTests = [...directTargetsByTest.keys()].sort();
  for (const target of input.targets)
    if (!coverageTests.some((test) => directTargetsByTest.get(test)?.includes(target)))
      errors.push(`no unmocked direct test is available for pure coverage proof: ${target}`);
  const coverage = new Set(coverageTests);
  const external = new Set(externalRuntimeTests);
  return {
    coverageTests,
    coverageGroups: input.targets.map((target) => ({
      target,
      tests: coverageTests.filter((test) => directTargetsByTest.get(test)?.includes(target)),
    })),
    behaviorOnlyTests: [...new Set(input.tests.map((test) => test.path))]
      .filter((test) => !coverage.has(test) && !external.has(test))
      .sort(),
    externalRuntimeTests,
    directTargetsByTest,
    errors,
  };
}

export function planCoverageBehaviorGroups(input: {
  shards: readonly {
    id: string;
    targets: readonly string[];
    tests: readonly CoverageShardTest[];
    resource_tags: readonly string[];
  }[];
  usesModuleMock: (test: string) => boolean;
}): CoverageBehaviorGroup[] {
  const groups = new Map<string, CoverageBehaviorGroup>();
  for (const shard of input.shards) {
    const plan = planCoverageShardExecution({
      targets: shard.targets,
      tests: shard.tests,
      usesModuleMock: input.usesModuleMock,
    });
    const resource_tags = [...new Set(shard.resource_tags)].sort();
    const key = resource_tags.join("\0");
    const group = groups.get(key) ?? { key, resource_tags, tests: [], shards: [] };
    group.tests.push(...plan.behaviorOnlyTests);
    group.shards.push(shard.id);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      tests: [...new Set(group.tests)].sort(),
      shards: [...new Set(group.shards)].sort(),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}
