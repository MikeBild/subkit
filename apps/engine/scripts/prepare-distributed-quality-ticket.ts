import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  canonicalDistributedQualityTicket,
  type DistributedQualityTicket,
  parseDistributedQualityTicket,
} from "./audit/distributed-quality-ticket.ts";
import {
  type MutationRuntimeSnapshot,
  validateMutationRuntimeSnapshot,
} from "./audit/mutation-runtime-snapshot.ts";
import { loadMutationWave } from "./run-mutation-shards.ts";

const repo = resolve(import.meta.dir, "../../..");
const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const value = (flag: string) => {
  const index = process.argv.indexOf(flag);
  const result = index < 0 ? undefined : process.argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
  return result;
};

export function createDistributedQualityTicket(options: {
  manifestPath: string;
  commit: string;
  githubRunId: string;
  baselineBudgets: Record<string, number>;
  campaignTimeoutMs: number;
  coverageRunId: string;
  mutationRunId: string;
  ticketPath: string;
  runtimeSnapshot: { path: string; sha256: string; snapshot: MutationRuntimeSnapshot };
}): DistributedQualityTicket {
  if (!/^[a-f0-9]{40}$/.test(options.commit)) throw new Error("Invalid coordinator commit");
  if (!Number.isSafeInteger(options.campaignTimeoutMs) || options.campaignTimeoutMs <= 0)
    throw new Error("Invalid campaign timeout");
  if (
    !/^\d+$/.test(options.githubRunId) ||
    !/^run-[a-z0-9-]+$/.test(options.coverageRunId) ||
    !/^run-[a-z0-9-]+$/.test(options.mutationRunId)
  )
    throw new Error("Invalid distributed run identity");
  const manifest_path = relative(repo, resolve(options.manifestPath));
  if (
    !parseDistributedQualityTicketPath(manifest_path) ||
    !parseDistributedQualityTicketPath(options.ticketPath)
  )
    throw new Error("Distributed ticket paths must be canonical repository paths");
  const prepared = loadMutationWave(repo, options.manifestPath);
  const { wave, manifestText } = prepared;
  if (!wave.quality_policy_sha256)
    throw new Error("Distributed quality requires a policy-bound wave");
  const runtime_snapshot_path = relative(repo, resolve(options.runtimeSnapshot.path));
  if (!parseDistributedQualityTicketPath(runtime_snapshot_path))
    throw new Error("Distributed runtime snapshot path must be canonical");
  if (
    options.runtimeSnapshot.snapshot.wave_id !== wave.wave_id ||
    options.runtimeSnapshot.snapshot.run_id !== options.mutationRunId ||
    options.runtimeSnapshot.snapshot.source_freeze_sha256 !== wave.source_freeze_sha256 ||
    options.runtimeSnapshot.snapshot.manifest_sha256 !== hash(manifestText) ||
    options.runtimeSnapshot.snapshot.artifact_digest_sha256 !== wave.runtime_artifact_digest_sha256
  )
    throw new Error("Distributed runtime snapshot differs from frozen wave");
  return {
    version: 2,
    coordinator_commit_sha: options.commit,
    github_run_id: options.githubRunId,
    coverage_run_id: options.coverageRunId,
    mutation_run_id: options.mutationRunId,
    manifest_path,
    ticket_path: options.ticketPath,
    wave_id: wave.wave_id,
    manifest_sha256: hash(manifestText),
    source_sha256: wave.source_freeze_sha256,
    test_sha256: wave.test_freeze_sha256,
    config_sha256: wave.config_sha256,
    lock_sha256: wave.lock_sha256,
    target_digest_sha256: wave.target_digest_sha256,
    quality_policy_sha256: wave.quality_policy_sha256,
    dynamic_import_ledger_sha256: wave.dynamic_import_ledger_sha256,
    equivalence_manifest_sha256: wave.equivalence_manifest_sha256,
    runtime_snapshot: {
      path: runtime_snapshot_path,
      sha256: options.runtimeSnapshot.sha256,
      artifact_digest_sha256: options.runtimeSnapshot.snapshot.artifact_digest_sha256,
      artifacts: options.runtimeSnapshot.snapshot.artifacts.map((artifact) => ({ ...artifact })),
    },
    campaign_timeout_ms: options.campaignTimeoutMs,
    shards: wave.shards.map((shard) => {
      const baseline_budget_ms = options.baselineBudgets[shard.id];
      if (!Number.isSafeInteger(baseline_budget_ms) || baseline_budget_ms <= 0)
        throw new Error(`Missing measured baseline budget for ${shard.id}`);
      return {
        id: shard.id,
        targets_sha256: hash(`${shard.targets.slice().sort().join("\n")}\n`),
        baseline_budget_ms,
      };
    }),
  };
}

const parseDistributedQualityTicketPath = (path: string) =>
  !path.startsWith("../") &&
  path !== ".." &&
  !path.startsWith("/") &&
  !path.split("/").some((part) => part === "" || part === "." || part === "..");

if (import.meta.main) {
  const manifest = resolve(repo, value("--manifest"));
  const out = resolve(repo, value("--out"));
  const ticketPath = value("--ticket-path");
  if (out !== resolve(repo, ticketPath)) throw new Error("--out must equal --ticket-path");
  const baselineBudgets = JSON.parse(
    readFileSync(resolve(repo, value("--baseline-budgets")), "utf8"),
  ) as Record<string, number>;
  const commit = value("--commit");
  if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim() !== commit)
    throw new Error("Coordinator commit does not match local HEAD");
  execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: repo });
  if (
    execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: repo,
      encoding: "utf8",
    }).trim()
  )
    throw new Error("Coordinator requires no untracked source inputs");
  const prepared = loadMutationWave(repo, manifest);
  if (!prepared.wave.runtime_artifact_digest_sha256)
    throw new Error("Frozen mutation wave lacks runtime artifact digest");
  const runtimeSnapshotPath = resolve(repo, value("--runtime-snapshot"));
  const runtimeSnapshot = validateMutationRuntimeSnapshot({
    path: runtimeSnapshotPath,
    sha256: value("--runtime-snapshot-sha256"),
    expected: {
      wave_id: prepared.wave.wave_id,
      run_id: value("--mutation-run-id"),
      source_freeze_sha256: prepared.wave.source_freeze_sha256,
      manifest_sha256: hash(prepared.manifestText),
      artifact_digest_sha256: prepared.wave.runtime_artifact_digest_sha256,
    },
  });
  const ticket = createDistributedQualityTicket({
    manifestPath: manifest,
    commit,
    githubRunId: value("--github-run-id"),
    baselineBudgets,
    campaignTimeoutMs: Number(value("--campaign-timeout-ms")),
    coverageRunId: value("--coverage-run-id"),
    mutationRunId: runtimeSnapshot.run_id,
    ticketPath,
    runtimeSnapshot: {
      path: runtimeSnapshotPath,
      sha256: value("--runtime-snapshot-sha256"),
      snapshot: runtimeSnapshot,
    },
  });
  parseDistributedQualityTicket(ticket);
  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, canonicalDistributedQualityTicket(ticket), { flag: "wx" });
  console.log(out);
}
