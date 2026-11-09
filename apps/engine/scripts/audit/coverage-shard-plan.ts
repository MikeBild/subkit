export interface CoverageShardTest {
  path: string;
  kind: string;
  covers_targets: readonly string[];
  execution?: "in_process" | "external_runtime";
}

export interface CoverageShardExecutionPlan {
  coverageTests: string[];
  behaviorOnlyTests: string[];
  externalRuntimeTests: string[];
  directTargetsByTest: Map<string, string[]>;
  errors: string[];
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
    behaviorOnlyTests: [...new Set(input.tests.map((test) => test.path))]
      .filter((test) => !coverage.has(test) && !external.has(test))
      .sort(),
    externalRuntimeTests,
    directTargetsByTest,
    errors,
  };
}
