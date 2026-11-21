import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  coverageDatabaseUrl,
  coverageExecutionContext,
  mutationShardEnvironment,
} from "../audit/coverage-environment.ts";

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

test("mutation shards run their tests against the owned database", () => {
  const owned = { SUBKIT_COVERAGE_OWNED_DATABASE_URL: "postgres://owned", PATH: "/bin" };
  expect(mutationShardEnvironment(owned, ["db"])).toEqual({
    ...owned,
    DATABASE_URL: "postgres://owned",
  });
  expect(
    mutationShardEnvironment({ ...owned, DATABASE_URL: "postgres://ambient" }, ["db"]).DATABASE_URL,
  ).toBe("postgres://owned");
  expect(mutationShardEnvironment(owned, []).DATABASE_URL).toBe("postgres://owned");
  expect(() => mutationShardEnvironment({ DATABASE_URL: "postgres://ambient" }, ["db"])).toThrow(
    "db-tagged mutation shard requires SUBKIT_COVERAGE_OWNED_DATABASE_URL",
  );
  expect(mutationShardEnvironment({ DATABASE_URL: "postgres://ambient" }, [])).toEqual({
    DATABASE_URL: "postgres://ambient",
  });
});

test("a shard whose tests open the database declares the db resource", () => {
  const policy = JSON.parse(
    readFileSync(join(import.meta.dir, "../../.quality-shard-policy.json"), "utf8"),
  ) as { shards: { id: string; resource_tags: string[] }[] };
  expect(policy.shards.find((shard) => shard.id === "cockpit")?.resource_tags).toContain("db");
});
