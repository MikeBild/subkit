import { createHash } from "node:crypto";
import { MUTATION_RUNTIME_ARTIFACTS } from "./mutation-runtime-snapshot.ts";
import { isCanonicalRepoPath } from "./mutation-wave.ts";

interface DistributedQualityTicketBase {
  coordinator_commit_sha: string;
  github_run_id: string;
  coverage_run_id: string;
  mutation_run_id: string;
  manifest_path: string;
  ticket_path: string;
  wave_id: string;
  manifest_sha256: string;
  source_sha256: string;
  test_sha256: string;
  config_sha256: string;
  lock_sha256: string;
  target_digest_sha256: string;
  quality_policy_sha256: string;
  dynamic_import_ledger_sha256: string;
  equivalence_manifest_sha256: string;
  shards: Array<{ id: string; targets_sha256: string; baseline_budget_ms: number }>;
  campaign_timeout_ms: number;
}

export interface DistributedQualityTicketV1 extends DistributedQualityTicketBase {
  version: 1;
}

export interface DistributedQualityRuntimeSnapshot {
  path: string;
  sha256: string;
  artifact_digest_sha256: string;
  artifacts: Array<{ path: string; sha256: string; bytes: number; executable: boolean }>;
}

export interface DistributedQualityTicketV2 extends DistributedQualityTicketBase {
  version: 2;
  runtime_snapshot: DistributedQualityRuntimeSnapshot;
}

export type DistributedQualityTicket = DistributedQualityTicketV1 | DistributedQualityTicketV2;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const isSha = (value: unknown, length = 64) =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);

export function canonicalDistributedQualityTicket(ticket: DistributedQualityTicket): string {
  return `${JSON.stringify({ ...ticket, shards: [...ticket.shards].sort((a, b) => a.id.localeCompare(b.id)) })}\n`;
}

export function distributedQualityTicketSha256(ticket: DistributedQualityTicket): string {
  return sha(canonicalDistributedQualityTicket(ticket));
}

export function parseDistributedQualityTicket(value: unknown): DistributedQualityTicket {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed distributed quality ticket");
  const ticket = value as DistributedQualityTicket;
  if (
    (ticket.version !== 1 && ticket.version !== 2) ||
    !isSha(ticket.coordinator_commit_sha, 40) ||
    typeof ticket.github_run_id !== "string" ||
    !/^\d+$/.test(ticket.github_run_id) ||
    !/^run-[a-z0-9-]+$/.test(ticket.coverage_run_id) ||
    !/^run-[a-z0-9-]+$/.test(ticket.mutation_run_id) ||
    !isCanonicalTicketPath(ticket.manifest_path) ||
    !isCanonicalTicketPath(ticket.ticket_path) ||
    typeof ticket.wave_id !== "string" ||
    !/^[a-z0-9][a-z0-9-]*$/.test(ticket.wave_id) ||
    ![
      ticket.manifest_sha256,
      ticket.source_sha256,
      ticket.test_sha256,
      ticket.config_sha256,
      ticket.lock_sha256,
      ticket.target_digest_sha256,
      ticket.quality_policy_sha256,
      ticket.dynamic_import_ledger_sha256,
      ticket.equivalence_manifest_sha256,
    ].every((digest) => isSha(digest)) ||
    !Number.isSafeInteger(ticket.campaign_timeout_ms) ||
    ticket.campaign_timeout_ms <= 0 ||
    !Array.isArray(ticket.shards) ||
    ticket.shards.length === 0
  )
    throw new Error("Malformed distributed quality ticket");
  const ids = new Set<string>();
  for (const shard of ticket.shards) {
    if (
      !shard ||
      typeof shard.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(shard.id) ||
      ids.has(shard.id) ||
      !isSha(shard.targets_sha256) ||
      !Number.isSafeInteger(shard.baseline_budget_ms) ||
      shard.baseline_budget_ms <= 0
    )
      throw new Error("Malformed or duplicate distributed quality shard");
    ids.add(shard.id);
  }
  if (ticket.version === 2) {
    const snapshot = (ticket as DistributedQualityTicketV2).runtime_snapshot;
    if (
      !snapshot ||
      !isCanonicalTicketPath(snapshot.path) ||
      !isSha(snapshot.sha256) ||
      !isSha(snapshot.artifact_digest_sha256) ||
      !Array.isArray(snapshot.artifacts) ||
      snapshot.artifacts.length !== MUTATION_RUNTIME_ARTIFACTS.length
    )
      throw new Error("Malformed distributed runtime snapshot binding");
    const paths = new Set<string>();
    for (const artifact of snapshot.artifacts) {
      if (
        !artifact ||
        !isCanonicalRepoPath(artifact.path) ||
        !isSha(artifact.sha256) ||
        !Number.isSafeInteger(artifact.bytes) ||
        artifact.bytes < 1 ||
        typeof artifact.executable !== "boolean" ||
        paths.has(artifact.path)
      )
        throw new Error("Malformed or duplicate distributed runtime snapshot artifact");
      paths.add(artifact.path);
    }
    if (
      JSON.stringify(snapshot.artifacts.map((artifact) => artifact.path)) !==
        JSON.stringify(MUTATION_RUNTIME_ARTIFACTS) ||
      snapshot.artifacts.some((artifact) => artifact.executable !== (artifact.path === "dist/sk"))
    )
      throw new Error(
        "Distributed runtime snapshot inventory differs from trusted runtime closure",
      );
  }
  return ticket;
}

export function assertDistributedRuntimeSnapshotArtifacts(
  ticket: DistributedQualityTicket,
  artifacts: readonly { path: string; sha256: string; bytes: number; executable: boolean }[],
): void {
  const row = (artifact: (typeof artifacts)[number]) =>
    [artifact.path, artifact.sha256, artifact.bytes, artifact.executable].join("\0");
  if (
    distributedRuntimeSnapshot(ticket).artifacts.map(row).join("\n") !==
    artifacts.map(row).join("\n")
  )
    throw new Error("Distributed runtime snapshot artifacts differ from snapshot manifest");
}

export function distributedRuntimeSnapshot(
  ticket: DistributedQualityTicket,
): DistributedQualityRuntimeSnapshot {
  if (ticket.version !== 2)
    throw new Error("Distributed executor requires a V2 runtime snapshot ticket");
  return ticket.runtime_snapshot;
}

const isCanonicalTicketPath = (path: unknown): path is string =>
  typeof path === "string" && isCanonicalRepoPath(path);

export function assertDistributedShardReceipt(options: {
  ticket: DistributedQualityTicket;
  ticketSha256: string;
  receipt: Record<string, unknown>;
  shardId: string;
  phase: "coverage" | "mutation";
  trustedCommit: string;
  trustedRunId: string;
}): void {
  const { ticket, ticketSha256, receipt, shardId, phase, trustedCommit, trustedRunId } = options;
  if (ticketSha256 !== distributedQualityTicketSha256(ticket))
    throw new Error("Distributed ticket hash is not canonical");
  if (!isSha(trustedCommit, 40) || !/^\d+$/.test(trustedRunId))
    throw new Error("Invalid trusted workflow identity");
  if (ticket.coordinator_commit_sha !== trustedCommit || ticket.github_run_id !== trustedRunId)
    throw new Error("Distributed ticket does not belong to trusted workflow identity");
  if (!ticket.shards.some((shard) => shard.id === shardId))
    throw new Error("Receipt shard is foreign to ticket");
  if (receipt.distributed_ticket_sha256 !== ticketSha256 || receipt.shard_id !== shardId)
    throw new Error("Receipt does not bind distributed ticket and shard");
  if (receipt.coordinator_commit_sha !== trustedCommit || receipt.github_run_id !== trustedRunId)
    throw new Error("Receipt has foreign workflow provenance");
  if (receipt.run_id !== (phase === "coverage" ? ticket.coverage_run_id : ticket.mutation_run_id))
    throw new Error("Receipt has foreign phase run id");
  for (const [key, expected] of Object.entries({
    wave_id: ticket.wave_id,
    manifest_sha256: ticket.manifest_sha256,
    source_sha256: ticket.source_sha256,
    test_sha256: ticket.test_sha256,
    base_config_sha256: ticket.config_sha256,
    lock_sha256: ticket.lock_sha256,
    target_digest_sha256: ticket.target_digest_sha256,
  }))
    if (receipt[key] !== expected)
      throw new Error(`Receipt ${key} differs from distributed ticket`);
  if (phase === "mutation") {
    const shard = distributedShard(ticket, shardId);
    const minutes = Math.ceil(shard.baseline_budget_ms / 60_000);
    if (
      receipt.baseline_budget_ms !== shard.baseline_budget_ms ||
      receipt.dry_run_timeout_minutes !== minutes
    )
      throw new Error("Receipt mutation dry-run budget differs from distributed ticket");
    if (ticket.version === 2) {
      const snapshot = distributedRuntimeSnapshot(ticket);
      if (
        receipt.runtime_snapshot_sha256 !== snapshot.sha256 ||
        receipt.runtime_artifact_digest_sha256 !== snapshot.artifact_digest_sha256
      )
        throw new Error("Receipt runtime snapshot differs from distributed ticket");
    } else if (
      receipt.runtime_snapshot_sha256 !== undefined ||
      receipt.runtime_artifact_digest_sha256 !== undefined
    )
      throw new Error("Receipt binds a runtime snapshot that a V1 distributed ticket cannot carry");
  }
}

export function assertCompleteDistributedShardSet(
  ticket: DistributedQualityTicket,
  receipts: Array<Record<string, unknown>>,
): void {
  const found = new Set<string>();
  for (const receipt of receipts) {
    if (typeof receipt.shard_id !== "string" || found.has(receipt.shard_id))
      throw new Error("Duplicate distributed shard receipt");
    found.add(receipt.shard_id);
  }
  const expected = new Set(ticket.shards.map((shard) => shard.id));
  if (found.size !== expected.size || [...expected].some((id) => !found.has(id)))
    throw new Error("Distributed shard receipts are incomplete");
}

export function distributedShard(
  ticket: DistributedQualityTicket,
  shardId: string,
): {
  id: string;
  targets_sha256: string;
  baseline_budget_ms: number;
} {
  const shard = ticket.shards.find((candidate) => candidate.id === shardId);
  if (!shard) throw new Error("Distributed shard is foreign to ticket");
  return shard;
}

export function assertDistributedWaveBinding(options: {
  ticket: DistributedQualityTicket;
  manifestText: string;
  wave: Record<string, unknown>;
  shardId: string;
  targets: readonly string[];
}): void {
  const { ticket, manifestText, wave, shardId, targets } = options;
  const shard = distributedShard(ticket, shardId);
  if (sha(manifestText) !== ticket.manifest_sha256)
    throw new Error("Frozen wave differs from distributed ticket");
  for (const [key, expected] of Object.entries({
    wave_id: ticket.wave_id,
    source_freeze_sha256: ticket.source_sha256,
    test_freeze_sha256: ticket.test_sha256,
    config_sha256: ticket.config_sha256,
    lock_sha256: ticket.lock_sha256,
    target_digest_sha256: ticket.target_digest_sha256,
    quality_policy_sha256: ticket.quality_policy_sha256,
    dynamic_import_ledger_sha256: ticket.dynamic_import_ledger_sha256,
    equivalence_manifest_sha256: ticket.equivalence_manifest_sha256,
  }))
    if (wave[key] !== expected)
      throw new Error(`Frozen wave ${key} differs from distributed ticket`);
  if (sha(`${[...targets].sort().join("\n")}\n`) !== shard.targets_sha256)
    throw new Error("Frozen shard targets differ from distributed ticket");
}
