import { expect, test } from "bun:test";
import { coverageDatabaseUrl, coverageExecutionContext } from "../audit/coverage-environment.ts";

test("db-tagged coverage shards require an explicit owned database URL", () => {
  expect(coverageDatabaseUrl({}, ["db"])).toEqual({
    error: "db-tagged coverage shard requires SUBKIT_COVERAGE_OWNED_DATABASE_URL",
  });
  expect(
    coverageDatabaseUrl({ SUBKIT_COVERAGE_OWNED_DATABASE_URL: "postgres://owned" }, ["db"]),
  ).toEqual({ url: "postgres://owned" });
  expect(coverageDatabaseUrl({}, [])).toEqual({});
});

test("coverage context ignores explicit CI orchestration metadata", () => {
  const coordinator = coverageExecutionContext(
    {
      FEATURE_FLAG: "enabled",
      ACTIONS_RUNTIME_TOKEN: "coordinator-token",
      GITHUB_JOB: "coordinator",
      GITHUB_OUTPUT: "/tmp/coordinator-output",
      GITHUB_RUN_ID: "101",
      GITHUB_WORKSPACE: "/home/runner/work/subkit/subkit",
      RUNNER_NAME: "GitHub Actions 1",
      RUNNER_OS: "Linux",
      SUBKIT_QUALITY_COMMIT: "a".repeat(40),
    },
    ["db"],
  );
  const worker = coverageExecutionContext(
    {
      FEATURE_FLAG: "enabled",
      ACTIONS_RUNTIME_TOKEN: "worker-token",
      GITHUB_JOB: "shard",
      GITHUB_OUTPUT: "/tmp/shard-output",
      GITHUB_RUN_ID: "101",
      GITHUB_WORKSPACE: "/home/runner/work/subkit/subkit",
      RUNNER_NAME: "GitHub Actions 15",
      RUNNER_OS: "Linux",
      SUBKIT_QUALITY_COMMIT: "a".repeat(40),
      SUBKIT_QUALITY_SHARD: "workflows",
    },
    ["db"],
  );
  expect(worker).toEqual(coordinator);
});

test("coverage context binds semantic test environment values", () => {
  const base = coverageExecutionContext({ FEATURE_FLAG: "enabled" }, []);
  expect(coverageExecutionContext({ FEATURE_FLAG: "disabled" }, [])).not.toEqual(base);
  expect(coverageExecutionContext({ FEATURE_FLAG: "enabled" }, ["db"])).not.toEqual(base);
  expect(coverageExecutionContext({ FEATURE_FLAG: "enabled", RUNNER_OS: "Linux" }, [])).not.toEqual(
    base,
  );
});
