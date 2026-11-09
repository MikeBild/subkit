import { expect, test } from "bun:test";
import { coverageDatabaseUrl } from "../audit/coverage-environment.ts";

test("db-tagged coverage shards require an explicit owned database URL", () => {
  expect(coverageDatabaseUrl({}, ["db"])).toEqual({
    error: "db-tagged coverage shard requires SUBKIT_COVERAGE_OWNED_DATABASE_URL",
  });
  expect(
    coverageDatabaseUrl({ SUBKIT_COVERAGE_OWNED_DATABASE_URL: "postgres://owned" }, ["db"]),
  ).toEqual({ url: "postgres://owned" });
  expect(coverageDatabaseUrl({}, [])).toEqual({});
});
