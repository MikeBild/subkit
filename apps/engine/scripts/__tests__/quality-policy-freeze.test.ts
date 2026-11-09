import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { digestWaveFiles, validateWaveFreeze } from "../audit/mutation-wave.ts";
import { frozenWaveFixture } from "./fixtures/frozen-wave.ts";

test("policy bytes and resource constraints remain bound during shard execution", () => {
  const fixture = frozenWaveFixture();
  try {
    const path = "apps/engine/.quality-shard-policy.json";
    const policy = {
      version: 1,
      worker_budget: 2,
      equivalence_manifest_path: fixture.wave.equivalence_manifest_path,
      shards: [{ id: "fixture", resource_tags: [] }],
    };
    const original = JSON.stringify(policy);
    fixture.put(path, original);
    const manifest = {
      ...fixture.wave,
      quality_policy_sha256: digestWaveFiles(fixture.root, [path]),
    };
    const check = () =>
      validateWaveFreeze({
        repo: fixture.root,
        manifest,
        runtime_inputs: [],
        instrumented_targets: true,
      });
    expect(check()).toEqual([]);
    fixture.put(path, `${original}\n`);
    expect(check()).toEqual(["quality policy"]);
    fixture.put(path, JSON.stringify({ ...policy, worker_budget: 3 }));
    expect(check).toThrow("Wave differs from reviewed quality policy");
    fixture.put(path, original);
    manifest.shards = manifest.shards.map((shard) => ({ ...shard, resource_tags: ["db"] }));
    expect(check).toThrow("Wave resource policy differs");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
