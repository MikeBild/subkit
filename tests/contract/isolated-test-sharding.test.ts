import path from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = path.resolve(import.meta.dir, "../..");
const runner = path.join(repoRoot, "scripts/test-files-isolated.ts");

function list(targets: string[], shard: string): string[] {
  const result = Bun.spawnSync(["bun", "run", runner, "--list", "--shard", shard, ...targets], {
    cwd: repoRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim().split("\n").filter(Boolean);
}

describe("isolated test sharding", () => {
  test("is deterministic, exhaustive, and assigns every repository test exactly once", () => {
    const target = ["apps", "packages"];
    const complete = list(target, "1/1");
    const shards = [1, 2, 3, 4, 5, 6, 7, 8].map((index) => list(target, `${index}/8`));
    expect(shards[0]).toEqual(list(target, "1/8"));
    const flattened = shards.flat();
    expect(new Set(flattened).size).toBe(complete.length);
    expect(flattened.sort()).toEqual(complete.sort());
  });
});
