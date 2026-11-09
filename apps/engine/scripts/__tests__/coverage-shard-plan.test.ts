import { expect, test } from "bun:test";
import {
  planCoverageBehaviorGroups,
  planCoverageShardExecution,
} from "../audit/coverage-shard-plan.ts";

const target = "apps/engine/src/example/core.ts";

test("keeps all direct contracts for one target in a single native coverage invocation", () => {
  const other = "apps/engine/src/other/core.ts";
  const plan = planCoverageShardExecution({
    targets: [target, other],
    tests: [
      { path: "first.test.ts", kind: "direct", covers_targets: [target] },
      { path: "second.test.ts", kind: "direct", covers_targets: [target, other] },
      { path: "mocked.test.ts", kind: "direct", covers_targets: [target] },
      { path: "consumer.test.ts", kind: "reverse_import", covers_targets: [target] },
    ],
    usesModuleMock: (test) => test === "mocked.test.ts",
  });
  expect(plan.coverageGroups).toEqual([
    { target, tests: ["first.test.ts", "second.test.ts"] },
    { target: other, tests: ["second.test.ts"] },
  ]);
  expect(plan.behaviorOnlyTests).toEqual(["consumer.test.ts", "mocked.test.ts"]);
  expect(plan.errors).toEqual([]);
});

test("uses only unmocked direct tests for coverage and retains every other closure test for isolated behavior", () => {
  const plan = planCoverageShardExecution({
    targets: [target],
    tests: [
      { path: "core.test.ts", kind: "direct", covers_targets: [target] },
      { path: "consumer.test.ts", kind: "reverse_import", covers_targets: [target] },
      { path: "mocked-direct.test.ts", kind: "direct", covers_targets: [target] },
    ],
    usesModuleMock: (test) => test === "mocked-direct.test.ts",
  });
  expect(plan.errors).toEqual([]);
  expect(plan.coverageTests).toEqual(["core.test.ts"]);
  expect(plan.behaviorOnlyTests).toEqual(["consumer.test.ts", "mocked-direct.test.ts"]);
  expect(plan.directTargetsByTest).toEqual(new Map([["core.test.ts", [target]]]));
});

test("fails closed when a target is covered only by mocked or non-direct tests", () => {
  const plan = planCoverageShardExecution({
    targets: [target],
    tests: [
      { path: "consumer.test.ts", kind: "reverse_import", covers_targets: [target] },
      { path: "mocked.test.ts", kind: "direct", covers_targets: [target] },
    ],
    usesModuleMock: (test) => test === "mocked.test.ts",
  });
  expect(plan.coverageTests).toEqual([]);
  expect(plan.behaviorOnlyTests).toEqual(["consumer.test.ts", "mocked.test.ts"]);
  expect(plan.errors).toEqual([
    `no unmocked direct test is available for pure coverage proof: ${target}`,
  ]);
});

test("keeps external-runtime Docker acceptance out of coverage and in-process behavior", () => {
  const plan = planCoverageShardExecution({
    targets: [target],
    tests: [
      { path: "core.test.ts", kind: "direct", covers_targets: [target], execution: "in_process" },
      {
        path: "tests/docker/bootstrap.docker.test.ts",
        kind: "reverse_import",
        covers_targets: [target],
        execution: "external_runtime",
      },
    ],
    usesModuleMock: () => false,
  });
  expect(plan.coverageTests).toEqual(["core.test.ts"]);
  expect(plan.behaviorOnlyTests).toEqual([]);
  expect(plan.externalRuntimeTests).toEqual(["tests/docker/bootstrap.docker.test.ts"]);
});

test("deduplicates only behavior tests with the same resource context", () => {
  const shared = { path: "consumer.test.ts", kind: "reverse_import", covers_targets: [target] };
  expect(
    planCoverageBehaviorGroups({
      shards: [
        { id: "a", targets: [target], tests: [shared], resource_tags: ["db"] },
        { id: "b", targets: [target], tests: [shared], resource_tags: ["db"] },
        { id: "c", targets: [target], tests: [shared], resource_tags: [] },
      ],
      usesModuleMock: () => false,
    }),
  ).toEqual([
    { key: "", resource_tags: [], tests: ["consumer.test.ts"], shards: ["c"] },
    { key: "db", resource_tags: ["db"], tests: ["consumer.test.ts"], shards: ["a", "b"] },
  ]);
});
