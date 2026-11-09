import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type CoverageShardNative,
  type CoverageShardReceipt,
  type CoverageUnionInput,
  validateCoverageShardUnion,
} from "../audit/coverage-union.ts";
import type { MutationWaveManifest } from "../audit/mutation-wave.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const sha = "a".repeat(64);
const paths = ["apps/engine/src/example/core-a.ts", "apps/engine/src/example/core-b.ts"] as const;
const lcov = (path: string, hit = 1) =>
  `SF:${path}\nFN:1,f\nFNDA:${hit},f\nFNF:1\nFNH:${hit}\nDA:1,${hit}\nLF:1\nLH:${hit}\nend_of_record\n`;
const wave: MutationWaveManifest = {
  version: 1,
  wave_id: "wave",
  source_freeze_sha256: sha,
  test_freeze_sha256: sha,
  target_digest_sha256: sha,
  config_sha256: sha,
  lock_sha256: sha,
  equivalence_manifest_sha256: sha,
  dynamic_import_ledger_sha256: sha,
  dynamic_import_ledger_path: "x",
  equivalence_manifest_path: "y",
  non_incremental: true,
  worker_budget: 1,
  shards: paths.map((target, index) => ({
    id: `s${index}`,
    targets: [target],
    tests: [],
    consumers: [],
    resource_tags: [],
  })),
};
function fixture(): CoverageUnionInput {
  const native: CoverageShardNative[] = wave.shards.map((shard) => {
    const target = shard.targets[0]!;
    const proof = lcov(target);
    const proofMeta = { target, path: `targets/${digest(target)}.lcov`, sha256: digest(proof) };
    const runId = "aaaaaaaaaa";
    const provenanceText = JSON.stringify({
      version: 4,
      config_sha256: sha,
      wave_id: "wave",
      shard_id: shard.id,
      manifest_sha256: sha,
      wave_source_freeze_sha256: sha,
      wave_test_freeze_sha256: sha,
      wave_target_digest_sha256: sha,
      wave_base_config_sha256: sha,
      direct_target_evidence: [proofMeta],
    });
    const receiptText = JSON.stringify({
      version: 1,
      run_id: runId,
      lcov: { path: "lcov.info", sha256: digest(proof) },
      provenance: { path: "provenance.json", sha256: digest(provenanceText) },
      direct_target_evidence: [proofMeta],
    });
    const latest = JSON.stringify({
      version: 1,
      run_id: runId,
      receipt: `runs/${runId}/receipt.json`,
      receipt_sha256: digest(receiptText),
    });
    return {
      id: shard.id,
      evidence_root: `/tmp/evidence-${shard.id}`,
      latest: {
        path: `/tmp/evidence-${shard.id}/latest.json`,
        sha256: digest(latest),
        contents: latest,
      },
      receiptText,
      provenanceText,
      lcovText: proof,
    };
  });
  const shards: CoverageShardReceipt[] = native.map((item) => {
    const shard = wave.shards.find((entry) => entry.id === item.id)!;
    const target = shard.targets[0]!;
    const proof = lcov(target);
    return {
      version: 1,
      wave_id: "wave",
      run_id: "run",
      shard_id: item.id,
      manifest_sha256: sha,
      source_sha256: sha,
      base_config_sha256: sha,
      coverage_config_sha256: sha,
      test_sha256: sha,
      target_digest_sha256: sha,
      native_receipt_sha256: digest(item.receiptText),
      native_provenance_sha256: digest(item.provenanceText),
      native_lcov_sha256: digest(item.lcovText),
      targets: shard.targets,
      direct_target_evidence: [
        { target, path: `targets/${digest(target)}.lcov`, sha256: digest(proof), lcov: proof },
      ],
    };
  });
  return {
    wave,
    runId: "run",
    manifestSha256: sha,
    sourceSha256: sha,
    canonicalScope: [...paths],
    shards,
    native,
    repo: process.cwd(),
  };
}

function rebindProvenance(
  value: CoverageUnionInput,
  index: number,
  provenance: Record<string, unknown>,
): void {
  const native = value.native[index]!;
  native.provenanceText = JSON.stringify(provenance);
  const receipt = JSON.parse(native.receiptText) as {
    provenance: { sha256: string };
  };
  receipt.provenance.sha256 = digest(native.provenanceText);
  native.receiptText = JSON.stringify(receipt);
  const latest = JSON.parse(native.latest.contents) as { receipt_sha256: string };
  latest.receipt_sha256 = digest(native.receiptText);
  native.latest.contents = JSON.stringify(latest);
  native.latest.sha256 = digest(native.latest.contents);
  value.shards[index]!.native_provenance_sha256 = digest(native.provenanceText);
  value.shards[index]!.native_receipt_sha256 = digest(native.receiptText);
}
test("accepts two immutable native snapshot chains", () =>
  expect(validateCoverageShardUnion(fixture())).toEqual([]));
test("requires explicit not-applicable receipt evidence for a type-only target", () => {
  const value = fixture();
  value.runtimeScope = [paths[0]!];
  for (const [index, receipt] of value.shards.entries()) {
    receipt.runtime_targets = index === 0 ? [paths[0]!] : [];
    receipt.type_only_targets = index === 0 ? [] : [paths[1]!];
  }
  const second = value.shards[1]!;
  second.type_only_targets = [];
  expect(validateCoverageShardUnion(value).join("\n")).toContain(
    "runtime/type-only audit mismatch",
  );
});
test("rejects each native provenance wave binding", () => {
  for (const key of [
    "wave_id",
    "shard_id",
    "manifest_sha256",
    "wave_source_freeze_sha256",
    "wave_test_freeze_sha256",
    "wave_target_digest_sha256",
    "wave_base_config_sha256",
  ] as const) {
    const value = fixture();
    const provenance = JSON.parse(value.native[0]!.provenanceText) as Record<string, unknown>;
    provenance[key] = "bad";
    rebindProvenance(value, 0, provenance);
    expect(validateCoverageShardUnion(value).join("\n")).toContain("provenance");
  }
});
test("rejects absent and mismatched native coverage config hashes after rehashing the full chain", () => {
  for (const next of [undefined, "b".repeat(64)]) {
    const value = fixture();
    const provenance = JSON.parse(value.native[0]!.provenanceText) as Record<string, unknown>;
    if (next === undefined) delete provenance.config_sha256;
    else provenance.config_sha256 = next;
    rebindProvenance(value, 0, provenance);
    expect(validateCoverageShardUnion(value).join("\n")).toContain("coverage config mismatch");
  }
});
test("rejects pointer receipt provenance proof and coverage deficits", () => {
  const pointer = fixture();
  pointer.native[0]!.latest.contents = "{}";
  expect(validateCoverageShardUnion(pointer).length).toBeGreaterThan(0);
  const proof = fixture();
  proof.shards[0]!.direct_target_evidence[0]!.lcov = lcov(paths[0], 0);
  proof.shards[0]!.direct_target_evidence[0]!.sha256 = digest(
    proof.shards[0]!.direct_target_evidence[0]!.lcov,
  );
  expect(validateCoverageShardUnion(proof).join("\n")).toContain("below 100");
});
