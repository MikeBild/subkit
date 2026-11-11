import {
  digestWaveFiles,
  type MutationWaveManifest,
  type MutationWaveShard,
} from "./mutation-wave.ts";

export const QUALITY_SHARD_POLICY_PATH = "apps/engine/.quality-shard-policy.json";

export interface CandidateQualityWaveManifest extends MutationWaveManifest {
  status: "candidate_unaccepted";
  quality_policy_sha256: string;
  target_count: number;
  unresolved_consumer_witnesses: readonly { shard: string; consumer: string }[];
}

export function createQualityWaveManifest(input: {
  repo: string;
  waveId: string;
  targetDigestSha256: string;
  equivalenceManifestPath: string;
  ledgerPath: string;
  workerBudget: number;
  externalRuntimeTests: readonly string[];
  targetCount: number;
  shards: readonly MutationWaveShard[];
  unresolved: readonly { shard: string; consumer: string }[];
}): CandidateQualityWaveManifest {
  const zero = "0".repeat(64);
  return {
    version: 1,
    status: "candidate_unaccepted",
    wave_id: input.waveId,
    source_freeze_sha256: zero,
    test_freeze_sha256: zero,
    target_digest_sha256: input.targetDigestSha256,
    quality_policy_sha256: digestWaveFiles(input.repo, [QUALITY_SHARD_POLICY_PATH]),
    config_sha256: zero,
    lock_sha256: zero,
    equivalence_manifest_path: input.equivalenceManifestPath,
    equivalence_manifest_sha256: zero,
    dynamic_import_ledger_path: input.ledgerPath,
    dynamic_import_ledger_sha256: zero,
    non_incremental: true,
    worker_budget: input.workerBudget,
    external_runtime_tests: input.externalRuntimeTests,
    target_count: input.targetCount,
    shards: input.shards,
    unresolved_consumer_witnesses: input.unresolved,
  };
}
