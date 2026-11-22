import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { verificationRunsRoot } from "../../../scripts/lib/verification-run-lifecycle.ts";
import { runWithVerificationLog } from "../../../scripts/run-with-verification-log.ts";
import { countDeadlineKills } from "./audit/core-tests.ts";
import { mutationShardEnvironment } from "./audit/coverage-environment.ts";
import {
  assertDistributedShardReceipt,
  assertDistributedWaveBinding,
  type DistributedQualityTicket,
} from "./audit/distributed-quality-ticket.ts";
import {
  nativeExactIgnoredMutant,
  readMutationEquivalentManifest,
} from "./audit/mutation-floor.ts";
import { assertNoMutationInfrastructureSentinel } from "./audit/mutation-infrastructure-sentinel.ts";
import { mutationClosureFiles, mutationTestInputs } from "./audit/mutation-inputs.ts";
import { pruneMutationReports } from "./audit/mutation-retention.ts";
import {
  createMutationRuntimeSnapshot,
  sealMutationRuntimeSnapshot,
  validateMutationRuntimeSnapshot,
} from "./audit/mutation-runtime-snapshot.ts";
import { planMutationBatches } from "./audit/mutation-scheduler.ts";
import { buildMutationShardConfig } from "./audit/mutation-shard-config.ts";
import {
  inspectMutationShardScore,
  summarizeMutationScores,
} from "./audit/mutation-shard-score.ts";
import {
  type MutationShardUnionInput,
  validateMutationShardUnion,
} from "./audit/mutation-union.ts";
import {
  createMutationValidationTicket,
  writeMutationValidationTicket,
} from "./audit/mutation-validation-ticket.ts";
import {
  readValidatedWaveManifest,
  validateWaveClosure,
  validateWaveFreeze,
} from "./audit/mutation-wave.ts";
import {
  assertCompletePureTargetInventory,
  canonicalPureTargetDigest,
  pureTargetSourceReader,
  runtimePureTargetPaths,
} from "./audit/pure-targets.ts";
import { assertCanonicalWaveOwners } from "./audit/quality-shard-policy.ts";

const REPO = resolve(import.meta.dir, "../../..");
const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const STRYKER_TEMP_PARENT = ".stryker-tmp";
const STRYKER_TEMP_MARKER = ".subkit-owned-parent";
const STRYKER_TEMP_MARKER_CONTENT = "subkit persistent stryker temp parent v1\n";

export function dryRunTimeoutMinutesForBaseline(baselineBudgetMs: number): number {
  if (!Number.isSafeInteger(baselineBudgetMs) || baselineBudgetMs <= 0)
    throw new Error("Mutation baseline budget must be a positive safe integer");
  return Math.ceil(baselineBudgetMs / 60_000);
}

export function ensurePersistentStrykerTempParent(repo: string): void {
  const parent = join(repo, STRYKER_TEMP_PARENT);
  const marker = join(parent, STRYKER_TEMP_MARKER);
  mkdirSync(parent, { recursive: true });
  if (!lstatSync(parent).isDirectory())
    throw new Error("Stryker temp parent is not an owned directory");
  const verify = () => {
    const stat = lstatSync(marker);
    if (!stat.isFile() || readFileSync(marker, "utf8") !== STRYKER_TEMP_MARKER_CONTENT)
      throw new Error("Stryker temp parent marker is not owned by Subkit");
  };
  try {
    verify();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    try {
      writeFileSync(marker, STRYKER_TEMP_MARKER_CONTENT, { encoding: "utf8", flag: "wx" });
    } catch (writeError) {
      if (!(writeError instanceof Error && "code" in writeError && writeError.code === "EEXIST"))
        throw writeError;
      verify();
    }
  }
}

export function loadMutationWave(repo: string, manifestPath: string) {
  const files = mutationClosureFiles(repo);
  const entries = assertCompletePureTargetInventory(files, pureTargetSourceReader(repo));
  const typeOnlyTargets = entries
    .filter((entry) => entry.runtime_kind === "type_only")
    .map((entry) => entry.path);
  const manifestText = readFileSync(manifestPath, "utf8");
  const wave = readValidatedWaveManifest({
    text: manifestText,
    canonical_targets: entries.map((entry) => entry.path),
    canonical_target_digest: canonicalPureTargetDigest(entries),
    known_files: files,
    type_only_targets: typeOnlyTargets,
  });
  if (wave.quality_policy_sha256) assertCanonicalWaveOwners(wave, entries);
  const stale = validateWaveFreeze({
    repo,
    manifest: wave,
    runtime_inputs: mutationTestInputs(repo),
  });
  if (stale.length > 0) throw new Error(`Stale mutation wave: ${stale.join(", ")}`);
  const closureErrors = validateWaveClosure({
    repo,
    wave,
    files,
    type_only_targets: typeOnlyTargets,
  });
  if (closureErrors.length > 0)
    throw new Error(`Incomplete mutation closure: ${closureErrors.join("; ")}`);
  const baseConfig = JSON.parse(readFileSync(join(repo, "stryker.config.json"), "utf8")) as unknown;
  const equivalents = readMutationEquivalentManifest(
    JSON.parse(readFileSync(join(repo, wave.equivalence_manifest_path), "utf8")),
    repo,
  );
  if ("error" in equivalents) throw new Error(equivalents.error);
  return { wave, manifestText, entries, baseConfig, equivalents };
}

export interface PreparedMutationShardExecution {
  repo: string;
  root: string;
  runId: string;
  manifestPath: string;
  manifestText: string;
  manifestSha256: string;
  wave: ReturnType<typeof loadMutationWave>["wave"];
  entries: ReturnType<typeof loadMutationWave>["entries"];
  baseConfig: unknown;
  equivalents: ReturnType<typeof loadMutationWave>["equivalents"];
  runtimeScope: readonly string[];
  workersByShard: Readonly<Record<string, number>>;
  runtimeSnapshot: ReturnType<typeof createMutationRuntimeSnapshot> & { sealSha256: string };
  ticket: ReturnType<typeof writeMutationValidationTicket>;
}

export function prepareMutationShardExecution(options: {
  repo: string;
  manifestPath: string;
  runId: string;
  root?: string;
}): PreparedMutationShardExecution {
  const prepared = loadMutationWave(options.repo, options.manifestPath);
  const root =
    options.root ??
    join(options.repo, ".reports/mutation/runs", prepared.wave.wave_id, options.runId);
  mkdirSync(root, { recursive: true });
  ensurePersistentStrykerTempParent(options.repo);
  const copiedManifestPath = join(root, "wave.json");
  const manifestText = prepared.manifestText;
  if (!lstatSync(copiedManifestPath, { throwIfNoEntry: false }))
    writeFileSync(copiedManifestPath, manifestText, { flag: "wx" });
  else if (readFileSync(copiedManifestPath, "utf8") !== manifestText)
    throw new Error("Immutable mutation wave differs from existing execution root");
  const ticketPath = join(root, "mutation-validation-ticket.json");
  if (!prepared.wave.runtime_artifact_digest_sha256)
    throw new Error("Frozen mutation wave lacks runtime artifact digest");
  const createdRuntimeSnapshot = createMutationRuntimeSnapshot({
    repo: options.repo,
    parentRunRoot: root,
    waveId: prepared.wave.wave_id,
    runId: options.runId,
    sourceFreezeSha256: prepared.wave.source_freeze_sha256,
    manifestSha256: hash(manifestText),
    artifactDigestSha256: prepared.wave.runtime_artifact_digest_sha256,
  });
  if (
    createdRuntimeSnapshot.snapshot.artifact_digest_sha256 !==
    prepared.wave.runtime_artifact_digest_sha256
  )
    throw new Error("Frozen mutation wave runtime artifact digest differs from snapshot");
  const runtimeSnapshot = {
    ...createdRuntimeSnapshot,
    sealSha256: sealMutationRuntimeSnapshot({
      path: createdRuntimeSnapshot.path,
      sha256: createdRuntimeSnapshot.sha256,
      expected: {
        wave_id: prepared.wave.wave_id,
        run_id: options.runId,
        source_freeze_sha256: prepared.wave.source_freeze_sha256,
        manifest_sha256: hash(manifestText),
        artifact_digest_sha256: prepared.wave.runtime_artifact_digest_sha256,
      },
    }),
  };
  const ticketInput = {
    repo: options.repo,
    parentRunRoot: root,
    copiedManifestPath,
    manifestText,
    wave: prepared.wave,
    entries: prepared.entries,
    runtimeInputs: mutationTestInputs(options.repo),
    closureFiles: mutationClosureFiles(options.repo),
    runtimeSnapshot,
    runId: options.runId,
  };
  const existingTicket = lstatSync(ticketPath, { throwIfNoEntry: false });
  const ticket = existingTicket
    ? (() => {
        if (!existingTicket.isFile() || existingTicket.isSymbolicLink())
          throw new Error("Mutation execution root validation ticket is invalid");
        const expected = `${JSON.stringify(createMutationValidationTicket(ticketInput), null, 2)}\n`;
        const text = readFileSync(ticketPath, "utf8");
        if (text !== expected) throw new Error("Mutation execution root validation ticket differs");
        return {
          path: ticketPath,
          sha256: hash(text),
          text,
          ticket: JSON.parse(text) as ReturnType<typeof createMutationValidationTicket>,
        };
      })()
    : writeMutationValidationTicket(ticketInput);
  const batches = planMutationBatches(prepared.wave.shards, prepared.wave.worker_budget);
  return {
    repo: options.repo,
    root,
    runId: options.runId,
    manifestPath: copiedManifestPath,
    manifestText,
    manifestSha256: hash(manifestText),
    wave: prepared.wave,
    entries: prepared.entries,
    baseConfig: prepared.baseConfig,
    equivalents: prepared.equivalents,
    runtimeScope: runtimePureTargetPaths(prepared.entries),
    workersByShard: Object.fromEntries(batches.flat().map(({ id, workers }) => [id, workers])),
    runtimeSnapshot,
    ticket,
  };
}

export async function executePreparedMutationShard(options: {
  prepared: PreparedMutationShardExecution;
  shardId: string;
  timeoutMs: number;
  distributed?: {
    ticket: DistributedQualityTicket;
    ticketSha256: string;
    commit: string;
    githubRunId: string;
  };
}): Promise<MutationShardUnionInput["shards"][number]> {
  const { prepared, shardId } = options;
  const shard = prepared.wave.shards.find((candidate) => candidate.id === shardId);
  if (!shard) throw new Error(`Mutation shard is absent from frozen wave: ${shardId}`);
  if (options.distributed) {
    assertDistributedWaveBinding({
      ticket: options.distributed.ticket,
      manifestText: prepared.manifestText,
      wave: prepared.wave as unknown as Record<string, unknown>,
      shardId,
      targets: shard.targets,
    });
  }
  const shardEnvironment = mutationShardEnvironment(process.env, shard.resource_tags);
  const directory = join(prepared.root, shardId);
  mkdirSync(directory, { recursive: false });
  const startedAt = new Date().toISOString();
  const runtimeTargets = shard.targets.filter((target) => prepared.runtimeScope.includes(target));
  const provenance = options.distributed
    ? {
        distributed_ticket_sha256: options.distributed.ticketSha256,
        coordinator_commit_sha: options.distributed.commit,
        github_run_id: options.distributed.githubRunId,
        baseline_budget_ms: options.distributed.ticket.shards.find(
          (candidate) => candidate.id === shardId,
        )!.baseline_budget_ms,
        dry_run_timeout_minutes: dryRunTimeoutMinutesForBaseline(
          options.distributed.ticket.shards.find((candidate) => candidate.id === shardId)!
            .baseline_budget_ms,
        ),
      }
    : {};
  const common = {
    version: 1 as const,
    parent_validation_ticket_path: relative(prepared.repo, prepared.ticket.path),
    parent_validation_ticket_sha256: prepared.ticket.sha256,
    wave_id: prepared.wave.wave_id,
    run_id: prepared.runId,
    shard_id: shardId,
    manifest_sha256: prepared.manifestSha256,
    base_config_sha256: prepared.wave.config_sha256,
    source_sha256: prepared.wave.source_freeze_sha256,
    test_sha256: prepared.wave.test_freeze_sha256,
    target_digest_sha256: prepared.wave.target_digest_sha256,
    canonical_target_sha256: prepared.wave.target_digest_sha256,
    lock_sha256: prepared.wave.lock_sha256,
    equivalence_manifest_sha256: prepared.wave.equivalence_manifest_sha256,
    dynamic_import_ledger_sha256: prepared.wave.dynamic_import_ledger_sha256,
    runtime_artifact_digest_sha256: prepared.runtimeSnapshot.snapshot.artifact_digest_sha256,
    runtime_snapshot_sha256: prepared.runtimeSnapshot.sha256,
    started_at: startedAt,
    targets: shard.targets,
    runtime_targets: runtimeTargets,
    type_only_targets: shard.targets.filter((target) => !prepared.runtimeScope.includes(target)),
    workers: prepared.workersByShard[shardId] ?? 0,
    ...provenance,
  };
  if (runtimeTargets.length === 0) {
    const receipt = {
      ...common,
      config_sha256: "",
      report_sha256: "",
      finished_at: new Date().toISOString(),
      exit_code: 0,
      not_applicable: "type_only_ast" as const,
    };
    const receiptText = json(receipt);
    writeFileSync(join(directory, "receipt.json"), receiptText, { flag: "wx" });
    return { id: shardId, receiptText, configText: "", reportText: "", exitCode: 0 };
  }
  const config = buildMutationShardConfig({
    base: prepared.baseConfig,
    waveId: prepared.wave.wave_id,
    runId: prepared.runId,
    manifestPath: prepared.manifestPath,
    ...(prepared.wave.quality_policy_sha256 ? { repo: prepared.repo } : {}),
    shard: { ...shard, targets: runtimeTargets },
    workers: common.workers,
    exactIgnoredMutants: prepared.equivalents.equivalents
      .filter((entry) => runtimeTargets.includes(entry.file))
      .map(nativeExactIgnoredMutant),
    ...(options.distributed
      ? {
          dryRunTimeoutMinutes: dryRunTimeoutMinutesForBaseline(
            options.distributed.ticket.shards.find((candidate) => candidate.id === shardId)!
              .baseline_budget_ms,
          ),
        }
      : {}),
  });
  const configText = json(config);
  const configPath = join(directory, "stryker.json");
  writeFileSync(configPath, configText, { flag: "wx" });
  writeFileSync(
    join(directory, "started.json"),
    json({
      started_at: startedAt,
      manifest_sha256: prepared.manifestSha256,
      config_sha256: hash(configText),
    }),
    { flag: "wx" },
  );
  const ticketEnv = {
    ...shardEnvironment,
    SUBKIT_MUTATION_ORIGINAL_REPO: prepared.repo,
    SUBKIT_MUTATION_PARENT_TICKET_PATH: prepared.ticket.path,
    SUBKIT_MUTATION_PARENT_TICKET_SHA256: prepared.ticket.sha256,
  };
  let exitCode: number;
  try {
    exitCode = await runWithVerificationLog({
      root: verificationRunsRoot(prepared.repo),
      owner: `mutation:${prepared.wave.wave_id}:${prepared.runId}:${shardId}`,
      sourceDigest: prepared.wave.source_freeze_sha256,
      command: "node",
      args: [
        join(prepared.repo, "node_modules/@stryker-mutator/core/bin/stryker.js"),
        "run",
        configPath,
        "--force",
      ],
      cwd: prepared.repo,
      env: ticketEnv,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    writeFileSync(join(directory, "failure.json"), json({ error: String(error) }), { flag: "wx" });
    throw error;
  }
  assertNoMutationInfrastructureSentinel(prepared.ticket.path);
  assertRuntimeSnapshotUnchanged(prepared);
  let reportText: string;
  try {
    reportText = readFileSync(join(directory, "mutation.json"), "utf8");
  } catch (error) {
    writeFileSync(
      join(directory, "failure.json"),
      json({ exit_code: exitCode, report_error: String(error) }),
      { flag: "wx" },
    );
    throw error;
  }
  const receipt = {
    ...common,
    config_sha256: hash(configText),
    report_sha256: hash(reportText),
    finished_at: new Date().toISOString(),
    exit_code: exitCode,
    deadline_kills: deadlineKills(prepared.ticket.path, shardId),
  };
  const receiptText = json(receipt);
  writeFileSync(join(directory, "receipt.json"), receiptText, { flag: "wx" });
  if (options.distributed)
    assertDistributedShardReceipt({
      ticket: options.distributed.ticket,
      ticketSha256: options.distributed.ticketSha256,
      receipt: receipt as Record<string, unknown>,
      shardId,
      phase: "mutation",
      trustedCommit: options.distributed.commit,
      trustedRunId: options.distributed.githubRunId,
    });
  return { id: shardId, receiptText, configText, reportText, exitCode };
}

function deadlineKills(ticketPath: string, shardId: string): number {
  const path = join(dirname(ticketPath), "deadline-kills", `${shardId}.jsonl`);
  return existsSync(path) ? countDeadlineKills(readFileSync(path, "utf8")) : 0;
}

function assertRuntimeSnapshotUnchanged(prepared: {
  wave: { wave_id: string; source_freeze_sha256: string };
  runId: string;
  manifestSha256: string;
  runtimeSnapshot: {
    path: string;
    sha256: string;
    sealSha256: string;
    snapshot: { artifact_digest_sha256: string };
  };
}): void {
  const input = {
    path: prepared.runtimeSnapshot.path,
    sha256: prepared.runtimeSnapshot.sha256,
    expected: {
      wave_id: prepared.wave.wave_id,
      run_id: prepared.runId,
      source_freeze_sha256: prepared.wave.source_freeze_sha256,
      manifest_sha256: prepared.manifestSha256,
      artifact_digest_sha256: prepared.runtimeSnapshot.snapshot.artifact_digest_sha256,
    },
  };
  validateMutationRuntimeSnapshot(input);
  if (sealMutationRuntimeSnapshot(input) !== prepared.runtimeSnapshot.sealSha256)
    throw new Error("Runtime snapshot seal changed during the mutation campaign");
}

export async function executeMutationShard(options: {
  repo: string;
  manifestPath: string;
  shardId: string;
  runId: string;
  campaignTimeoutMs: number;
  distributed: {
    ticket: DistributedQualityTicket;
    ticketSha256: string;
    commit: string;
    githubRunId: string;
  };
}): Promise<MutationShardUnionInput["shards"][number]> {
  const prepared = prepareMutationShardExecution({
    repo: options.repo,
    manifestPath: options.manifestPath,
    runId: options.runId,
  });
  if (options.distributed.ticket.mutation_run_id !== options.runId)
    throw new Error("Coordinator mutation run id differs from shard run id");
  if (options.distributed.ticket.campaign_timeout_ms !== options.campaignTimeoutMs)
    throw new Error("Coordinator campaign timeout differs from shard deadline");
  return executePreparedMutationShard({
    prepared,
    shardId: options.shardId,
    timeoutMs: options.campaignTimeoutMs,
    distributed: options.distributed,
  });
}

export function collectMutationShardUnion(options: {
  prepared: PreparedMutationShardExecution;
  shards: readonly MutationShardUnionInput["shards"][number][];
  distributed?: {
    ticket: DistributedQualityTicket;
    ticketSha256: string;
    commit: string;
    githubRunId: string;
  };
}): string[] {
  const { prepared } = options;
  if (options.distributed)
    for (const shard of prepared.wave.shards)
      assertDistributedWaveBinding({
        ticket: options.distributed.ticket,
        manifestText: prepared.manifestText,
        wave: prepared.wave as unknown as Record<string, unknown>,
        shardId: shard.id,
        targets: shard.targets,
      });
  return validateMutationShardUnion({
    wave: prepared.wave,
    runId: prepared.runId,
    manifestPath: prepared.manifestPath,
    baseConfig: prepared.baseConfig,
    canonicalScope: prepared.entries.map((entry) => entry.path),
    runtimeScope: prepared.runtimeScope,
    sourceSha256: prepared.wave.source_freeze_sha256,
    testSha256: prepared.wave.test_freeze_sha256,
    workersByShard: prepared.workersByShard,
    shards: options.shards,
    manifestSha256: prepared.manifestSha256,
    equivalenceManifest: prepared.equivalents,
    repo: prepared.repo,
    sourceSha256ForFile: (file) => hash(readFileSync(join(prepared.repo, file))),
    ...(options.distributed ? { distributed: options.distributed } : {}),
  });
}

export function publishMutationShardUnion(options: {
  prepared: PreparedMutationShardExecution;
  shards: readonly MutationShardUnionInput["shards"][number][];
  distributed?: {
    ticket: DistributedQualityTicket;
    ticketSha256: string;
    commit: string;
    githubRunId: string;
  };
}): string {
  const errors = collectMutationShardUnion(options);
  if (errors.length) throw new Error(`Mutation union rejected: ${errors.join("; ")}`);
  const { prepared, shards } = options;
  const scores = shards.flatMap((result) => {
    if (!result.reportText) return [];
    const targets = prepared.wave.shards
      .find((shard) => shard.id === result.id)!
      .targets.filter((target) => prepared.runtimeScope.includes(target));
    return inspectMutationShardScore({
      report: JSON.parse(result.reportText),
      exitCode: result.exitCode,
      manifest: {
        ...prepared.equivalents,
        equivalents: prepared.equivalents.equivalents.filter((entry) =>
          targets.includes(entry.file),
        ),
      },
      repo: prepared.repo,
      expectedScope: targets,
      sourceSha256ForFile: (file) => hash(readFileSync(join(prepared.repo, file))),
    }).scores;
  });
  const scoreSummary = summarizeMutationScores(scores);
  const unionPath = join(prepared.root, "union.json");
  writeFileSync(
    unionPath,
    json({
      version: 1,
      wave_id: prepared.wave.wave_id,
      run_id: prepared.runId,
      manifest_sha256: prepared.manifestSha256,
      target_count: prepared.entries.length,
      shards: shards.map((result) => ({ id: result.id, receipt_sha256: hash(result.receiptText) })),
      mutation_score: scoreSummary.adjusted_score,
      raw_mutation_score: scoreSummary.raw_score,
      adjusted_mutation_score: scoreSummary.adjusted_score,
      score_summary: scoreSummary,
      coverage_verification: "pending",
    }),
    { flag: "wx" },
  );
  return unionPath;
}

export async function executeMutationWave(options: {
  repo: string;
  manifestPath: string;
  timeoutMs: number;
}): Promise<string> {
  const loaded = loadMutationWave(options.repo, options.manifestPath);
  const runId = `run-${randomUUID()}`;
  const prepared = prepareMutationShardExecution({
    repo: options.repo,
    manifestPath: options.manifestPath,
    runId,
  });
  const results: MutationShardUnionInput["shards"][number][] = [];
  const batches = planMutationBatches(loaded.wave.shards, loaded.wave.worker_budget);
  for (const batch of batches) {
    const outcomes = await Promise.allSettled(
      batch.map(({ id }) =>
        executePreparedMutationShard({ prepared, shardId: id, timeoutMs: options.timeoutMs }),
      ),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [String(outcome.reason)] : [],
    );
    results.push(
      ...outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : [])),
    );
    if (failures.length) {
      writeFileSync(join(prepared.root, "failed.json"), json({ failures }), { flag: "wx" });
      throw new Error(
        `Mutation wave failed; retained evidence at ${prepared.root}: ${failures.join("; ")}`,
      );
    }
  }
  let unionPath: string;
  try {
    unionPath = publishMutationShardUnion({ prepared, shards: results });
  } catch (error) {
    writeFileSync(
      join(prepared.root, "failed.json"),
      json({ phase: "mutation-union", error: String(error) }),
      { flag: "wx" },
    );
    throw error;
  }
  try {
    pruneMutationReports(join(options.repo, ".reports"), {
      keep: [{ wave: loaded.wave.wave_id, run: runId }],
      apply: true,
    });
  } catch (error) {
    console.warn(`mutation report retention skipped: ${(error as Error).message}`);
  }
  return unionPath;
}

export function parseMutationExecutorArgs(args: readonly string[]): {
  manifest: string;
  mode: "plan" | "run";
} {
  let manifest: string | undefined;
  let mode: "plan" | "run" | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--manifest" && manifest === undefined) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("--manifest requires a file path");
      manifest = value;
    } else if ((arg === "--plan" || arg === "--run") && mode === undefined) {
      mode = arg === "--plan" ? "plan" : "run";
    } else throw new Error(`Unknown, duplicate or conflicting mutation option: ${arg}`);
  }
  if (!manifest) throw new Error("--manifest is required");
  return { manifest, mode: mode ?? "plan" };
}

if (import.meta.main) {
  const options = parseMutationExecutorArgs(process.argv.slice(2));
  const manifestPath = resolve(REPO, options.manifest);
  if (options.mode === "run")
    console.log(
      await executeMutationWave({ repo: REPO, manifestPath, timeoutMs: 6 * 60 * 60 * 1000 }),
    );
  else {
    const { wave } = loadMutationWave(REPO, manifestPath);
    console.log(json(planMutationBatches(wave.shards, wave.worker_budget)));
  }
}
