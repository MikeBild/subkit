import { expect, test } from "bun:test";
import {
  assertCompleteDistributedShardSet,
  assertDistributedRuntimeSnapshotArtifacts,
  assertDistributedShardReceipt,
  type DistributedQualityTicket,
  distributedQualityTicketSha256,
  parseDistributedQualityTicket,
} from "../audit/distributed-quality-ticket.ts";
import { MUTATION_RUNTIME_ARTIFACTS } from "../audit/mutation-runtime-snapshot.ts";

const ticket: DistributedQualityTicket = {
  version: 1,
  coordinator_commit_sha: "a".repeat(40),
  github_run_id: "12",
  coverage_run_id: "run-coverage-12",
  mutation_run_id: "run-mutation-12",
  manifest_path: "reports/quality-inputs/wave.json",
  ticket_path: "reports/quality-inputs/ticket.json",
  wave_id: "wave-12",
  manifest_sha256: "b".repeat(64),
  source_sha256: "c".repeat(64),
  test_sha256: "d".repeat(64),
  config_sha256: "e".repeat(64),
  lock_sha256: "f".repeat(64),
  target_digest_sha256: "4".repeat(64),
  quality_policy_sha256: "5".repeat(64),
  dynamic_import_ledger_sha256: "1".repeat(64),
  equivalence_manifest_sha256: "2".repeat(64),
  campaign_timeout_ms: 600_000,
  shards: [{ id: "alpha", targets_sha256: "3".repeat(64), baseline_budget_ms: 120_000 }],
};
const receipt = () => ({
  baseline_budget_ms: 120_000,
  dry_run_timeout_minutes: 2,
  distributed_ticket_sha256: distributedQualityTicketSha256(ticket),
  shard_id: "alpha",
  coordinator_commit_sha: "a".repeat(40),
  github_run_id: "12",
  run_id: "run-mutation-12",
  wave_id: "wave-12",
  manifest_sha256: "b".repeat(64),
  source_sha256: "c".repeat(64),
  test_sha256: "d".repeat(64),
  base_config_sha256: "e".repeat(64),
  lock_sha256: "f".repeat(64),
  target_digest_sha256: "4".repeat(64),
});

test("portable ticket forbids host paths and duplicate shards", () => {
  expect(() =>
    parseDistributedQualityTicket({ ...ticket, manifest_path: "/tmp/wave.json" }),
  ).toThrow();
  expect(() =>
    parseDistributedQualityTicket({ ...ticket, shards: [...ticket.shards, ticket.shards[0]] }),
  ).toThrow();
  expect(() =>
    parseDistributedQualityTicket({ ...ticket, quality_policy_sha256: "policy" }),
  ).toThrow();
});
test("receipt rejects a foreign run, commit, or ticket", () => {
  expect(() =>
    assertDistributedShardReceipt({
      ticket,
      ticketSha256: distributedQualityTicketSha256(ticket),
      receipt: { ...receipt(), github_run_id: "13" },
      shardId: "alpha",
      phase: "mutation",
      trustedCommit: "a".repeat(40),
      trustedRunId: "12",
    }),
  ).toThrow("foreign");
  expect(() =>
    assertDistributedShardReceipt({
      ticket,
      ticketSha256: "0".repeat(64),
      receipt: receipt(),
      shardId: "alpha",
      phase: "mutation",
      trustedCommit: "a".repeat(40),
      trustedRunId: "12",
    }),
  ).toThrow("canonical");
  expect(() =>
    assertDistributedShardReceipt({
      ticket,
      ticketSha256: distributedQualityTicketSha256(ticket),
      receipt: receipt(),
      shardId: "alpha",
      phase: "coverage",
      trustedCommit: "a".repeat(40),
      trustedRunId: "12",
    }),
  ).toThrow("phase");
});
test("merge rejects missing and duplicate distributed shards", () => {
  expect(() => assertCompleteDistributedShardSet(ticket, [])).toThrow("incomplete");
  expect(() => assertCompleteDistributedShardSet(ticket, [receipt(), receipt()])).toThrow(
    "Duplicate",
  );
});

test("accepts the complete canonical ticket and correctly bound mutation receipt", () => {
  expect(parseDistributedQualityTicket(ticket)).toEqual(ticket);
  expect(() =>
    assertDistributedShardReceipt({
      ticket,
      ticketSha256: distributedQualityTicketSha256(ticket),
      receipt: receipt(),
      shardId: "alpha",
      phase: "mutation",
      trustedCommit: "a".repeat(40),
      trustedRunId: "12",
    }),
  ).not.toThrow();
  expect(() =>
    assertDistributedShardReceipt({
      ticket,
      ticketSha256: distributedQualityTicketSha256(ticket),
      receipt: { ...receipt(), baseline_budget_ms: 1 },
      shardId: "alpha",
      phase: "mutation",
      trustedCommit: "a".repeat(40),
      trustedRunId: "12",
    }),
  ).toThrow("budget");
});

test("V1 receipts cannot carry runtime snapshot bindings", () => {
  for (const extra of [
    { runtime_snapshot_sha256: "6".repeat(64) },
    { runtime_artifact_digest_sha256: "7".repeat(64) },
  ])
    expect(() =>
      assertDistributedShardReceipt({
        ticket,
        ticketSha256: distributedQualityTicketSha256(ticket),
        receipt: { ...receipt(), ...extra },
        shardId: "alpha",
        phase: "mutation",
        trustedCommit: "a".repeat(40),
        trustedRunId: "12",
      }),
    ).toThrow("V1 distributed ticket cannot carry");
});

test("V2 ticket artifacts must equal the restored snapshot manifest", () => {
  const artifacts = MUTATION_RUNTIME_ARTIFACTS.map((path, index) => ({
    path,
    sha256: String(index % 10).repeat(64),
    bytes: index + 1,
    executable: path === "dist/sk",
  }));
  const v2 = parseDistributedQualityTicket({
    ...ticket,
    version: 2,
    runtime_snapshot: {
      path: "reports/mutation/runs/wave-12/run-mutation-12/runtime-snapshots/snapshot",
      sha256: "8".repeat(64),
      artifact_digest_sha256: "9".repeat(64),
      artifacts,
    },
  });
  expect(() => assertDistributedRuntimeSnapshotArtifacts(v2, artifacts)).not.toThrow();
  expect(() =>
    assertDistributedRuntimeSnapshotArtifacts(
      v2,
      artifacts.map((artifact, index) =>
        index === 0 ? { ...artifact, sha256: "a".repeat(64) } : artifact,
      ),
    ),
  ).toThrow("differ from snapshot manifest");
  expect(() => assertDistributedRuntimeSnapshotArtifacts(v2, artifacts.slice(1))).toThrow(
    "differ from snapshot manifest",
  );
  expect(() => assertDistributedRuntimeSnapshotArtifacts(ticket, artifacts)).toThrow("V2");
});
