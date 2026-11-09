import { expect, test } from "bun:test";
import { coverageShardConcurrency, relativeCoverageEvidencePath } from "../run-coverage-shards.ts";

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
