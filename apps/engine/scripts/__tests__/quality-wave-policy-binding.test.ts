import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestWaveFiles } from "../audit/mutation-wave.ts";
import {
  createQualityWaveManifest,
  QUALITY_SHARD_POLICY_PATH,
} from "../audit/quality-wave-manifest.ts";

test("candidate wave manifest binds policy bytes and preserves generator fields", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-wave-policy-binding-"));
  try {
    const path = join(root, QUALITY_SHARD_POLICY_PATH);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, '{"version":1}\n');
    const input = {
      repo: root,
      waveId: "quality-policy-binding",
      targetDigestSha256: "a".repeat(64),
      equivalenceManifestPath: "apps/engine/.mutation-equivalents.json",
      ledgerPath: ".tmp/ledger.json",
      workerBudget: 2,
      externalRuntimeTests: ["tests/docker/fixture.test.ts"],
      targetCount: 1,
      shards: [
        {
          id: "fixture",
          targets: ["packages/shared/src/fixture.ts"],
          tests: [],
          consumers: [],
          resource_tags: [],
        },
      ],
      unresolved: [],
    };
    const first = createQualityWaveManifest(input);
    expect(first).toMatchObject({
      version: 1,
      status: "candidate_unaccepted",
      wave_id: input.waveId,
      target_digest_sha256: input.targetDigestSha256,
      worker_budget: input.workerBudget,
      shards: input.shards,
      unresolved_consumer_witnesses: input.unresolved,
      quality_policy_sha256: digestWaveFiles(root, [QUALITY_SHARD_POLICY_PATH]),
    });
    writeFileSync(path, '{"version":2}\n');
    expect(createQualityWaveManifest(input).quality_policy_sha256).not.toBe(
      first.quality_policy_sha256,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
