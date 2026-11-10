import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { verificationRunsRoot } from "../../../scripts/lib/verification-run-lifecycle.ts";
import { runWithVerificationLog } from "../../../scripts/run-with-verification-log.ts";
import { readPublishedCoverage } from "./audit/coverage-artifacts.ts";
import { executeCoverageBehaviorTests } from "./audit/coverage-behavior-proof.ts";
import {
  coverageDatabaseUrl,
  coverageExecutionContext,
  coverageTestEnvironment,
} from "./audit/coverage-environment.ts";
import { planCoverageBehaviorGroups } from "./audit/coverage-shard-plan.ts";
import {
  type CoverageShardNative,
  type CoverageShardReceipt,
  validateCoverageShardUnion,
} from "./audit/coverage-union.ts";
import {
  assertDistributedWaveBinding,
  type DistributedQualityTicket,
} from "./audit/distributed-quality-ticket.ts";
import { planMutationBatches } from "./audit/mutation-scheduler.ts";
import { runtimePureTargetPaths } from "./audit/pure-targets.ts";
import { loadMutationWave, parseMutationExecutorArgs } from "./run-mutation-shards.ts";

const REPO = resolve(import.meta.dir, "../../..");
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function coverageShardConcurrency(workers: number, resourceTags: readonly string[]): string {
  return String(resourceTags.length > 0 ? 1 : Math.max(1, Math.min(4, workers)));
}

export function relativeCoverageEvidencePath(repo: string, path: string): string {
  const value = relative(repo, path);
  if (!value || value.startsWith("../") || value === "..")
    throw new Error(`coverage evidence escapes repository: ${path}`);
  return value;
}

export async function executeCoverageBehaviorGroups(options: {
  repo: string;
  manifestPath: string;
  runId: string;
  artifactRoot: string;
}): Promise<Map<string, string>> {
  const prepared = loadMutationWave(options.repo, options.manifestPath);
  const { wave, manifestText, entries } = prepared;
  const runtimeScope = runtimePureTargetPaths(entries);
  const manifestSha256 = hash(manifestText);
  const receipts = new Map<string, string>();
  mkdirSync(options.artifactRoot, { recursive: true });
  const shards = wave.shards.map((shard) => ({
    ...shard,
    targets: shard.targets.filter((target) => runtimeScope.includes(target)),
  }));
  for (const group of planCoverageBehaviorGroups({
    shards,
    usesModuleMock: (test) =>
      readFileSync(join(options.repo, test), "utf8").includes("mock.module("),
  })) {
    const database = coverageDatabaseUrl(process.env, group.resource_tags);
    if (database.error) throw new Error(database.error);
    const environment = coverageTestEnvironment(process.env, database.url);
    const contextSha256 = hash(json(coverageExecutionContext(environment, group.resource_tags)));
    const terminal = await executeCoverageBehaviorTests({
      repo: options.repo,
      artifactRoot: options.artifactRoot,
      owner: `coverage-behavior:${wave.wave_id}:${options.runId}`,
      sourceDigest: wave.source_freeze_sha256,
      contextSha256,
      tests: group.tests,
      env: environment,
    });
    for (const shardId of group.shards) {
      const shard = shards.find((candidate) => candidate.id === shardId)!;
      const local = planCoverageBehaviorGroups({
        shards: [shard],
        usesModuleMock: (test) =>
          readFileSync(join(options.repo, test), "utf8").includes("mock.module("),
      })[0]!.tests;
      const path = join(options.artifactRoot, `${hash(`${shardId}\0${local.join("\0")}`)}.json`);
      writeFileSync(
        path,
        json({
          version: 2,
          wave_id: wave.wave_id,
          manifest_sha256: manifestSha256,
          source_sha256: wave.source_freeze_sha256,
          test_sha256: wave.test_freeze_sha256,
          config_sha256: wave.config_sha256,
          context_sha256: contextSha256,
          resource_tags: group.resource_tags,
          tests: local,
          executed_tests: group.tests,
          terminal,
        }),
        { flag: "wx" },
      );
      receipts.set(shardId, path);
    }
  }
  return receipts;
}

export function collectCoverageShardUnion(options: {
  repo: string;
  manifestPath: string;
  runId: string;
  shardRoots: ReadonlyMap<string, string>;
  outputRoot: string;
  distributed?: {
    ticket: DistributedQualityTicket;
    ticketSha256: string;
    commit: string;
    githubRunId: string;
  };
}): string {
  const { wave, manifestText, entries } = loadMutationWave(options.repo, options.manifestPath);
  const runtimeScope = runtimePureTargetPaths(entries);
  const receipts: CoverageShardReceipt[] = [];
  const native: CoverageShardNative[] = [];
  if (options.distributed)
    for (const shard of wave.shards)
      assertDistributedWaveBinding({
        ticket: options.distributed.ticket,
        manifestText,
        wave: wave as unknown as Record<string, unknown>,
        shardId: shard.id,
        targets: shard.targets,
      });
  for (const shard of wave.shards) {
    const root = options.shardRoots.get(shard.id);
    if (!root) throw new Error(`Coverage collector missing shard root: ${shard.id}`);
    const directory = join(root, shard.id);
    receipts.push(
      JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8")) as CoverageShardReceipt,
    );
    if (shard.targets.some((target) => runtimeScope.includes(target))) {
      const published = readPublishedCoverage(join(directory, "coverage"));
      native.push({
        id: shard.id,
        evidence_root: join(directory, "coverage"),
        latest: {
          path: published.latestPath,
          sha256: hash(published.latestContents),
          contents: published.latestContents,
        },
        receiptText: readFileSync(published.receiptPath, "utf8"),
        provenanceText: readFileSync(published.provenancePath, "utf8"),
        lcovText: readFileSync(published.lcovPath, "utf8"),
      });
    }
  }
  const errors = validateCoverageShardUnion({
    wave,
    runId: options.runId,
    manifestSha256: hash(manifestText),
    sourceSha256: wave.source_freeze_sha256,
    canonicalScope: entries.map((entry) => entry.path),
    runtimeScope,
    shards: receipts,
    native,
    repo: options.repo,
    ...(options.distributed ? { distributed: options.distributed } : {}),
  });
  if (errors.length) throw new Error(`Coverage union rejected: ${errors.join("; ")}`);
  mkdirSync(options.outputRoot, { recursive: true });
  const path = join(options.outputRoot, "union.json");
  writeFileSync(
    path,
    json({
      version: 1,
      wave_id: wave.wave_id,
      run_id: options.runId,
      manifest_sha256: hash(manifestText),
      target_count: entries.length,
      shards: receipts.map((receipt) => ({
        id: receipt.shard_id,
        receipt_sha256: hash(json(receipt)),
      })),
      coverage: { line: 100, function: 100 },
      mutation_verification: "pending",
    }),
    { flag: "wx" },
  );
  return path;
}

export async function executeCoverageWave(options: {
  repo: string;
  manifestPath: string;
  timeoutMs: number;
  runId?: string;
  outputRoot?: string;
  shardIds?: readonly string[];
  behaviorReceipts?: ReadonlyMap<string, string>;
  distributed?: {
    ticket: DistributedQualityTicket;
    ticketSha256: string;
    commit: string;
    githubRunId: string;
  };
}): Promise<string> {
  const { repo, manifestPath, timeoutMs } = options;
  const prepared = loadMutationWave(repo, manifestPath);
  const { wave, manifestText, entries } = prepared;
  const runtimeScope = runtimePureTargetPaths(entries);
  const manifestSha256 = hash(manifestText);
  const runId = options.runId ?? `run-${randomUUID()}`;
  const root = options.outputRoot ?? join(repo, "reports/coverage/shards", wave.wave_id, runId);
  if (options.distributed) {
    if (
      options.distributed.ticket.coverage_run_id !== runId ||
      options.distributed.ticket.campaign_timeout_ms !== timeoutMs
    )
      throw new Error("Distributed coverage run differs from portable ticket");
    for (const shard of wave.shards)
      assertDistributedWaveBinding({
        ticket: options.distributed.ticket,
        manifestText,
        wave: wave as unknown as Record<string, unknown>,
        shardId: shard.id,
        targets: shard.targets,
      });
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "wave.json"), manifestText, { flag: "wx" });
  const assertUnchanged = () => {
    const current = loadMutationWave(repo, manifestPath);
    if (hash(current.manifestText) !== manifestSha256)
      throw new Error("Coverage wave changed during execution");
  };
  const behaviorRoot = join(root, "behavior");
  mkdirSync(behaviorRoot);
  const behaviorReceipts = new Map(options.behaviorReceipts);
  if (behaviorReceipts.size === 0)
    for (const [shardId, path] of await executeCoverageBehaviorGroups({
      repo,
      manifestPath,
      runId,
      artifactRoot: behaviorRoot,
    }))
      behaviorReceipts.set(shardId, path);
  const selectedIds = new Set(options.shardIds ?? wave.shards.map((shard) => shard.id));
  if (
    selectedIds.size === 0 ||
    [...selectedIds].some((id) => !wave.shards.some((shard) => shard.id === id))
  )
    throw new Error("Coverage executor has an unknown or empty shard selection");
  const batches = planMutationBatches(
    wave.shards.filter((shard) => selectedIds.has(shard.id)),
    wave.worker_budget,
  );
  const receipts: CoverageShardReceipt[] = [];
  const native: CoverageShardNative[] = [];
  try {
    for (const batch of batches) {
      assertUnchanged();
      const outcomes = await Promise.allSettled(
        batch.map(async ({ id, workers }) => {
          const shard = wave.shards.find((candidate) => candidate.id === id);
          if (!shard) throw new Error(`missing scheduled coverage shard: ${id}`);
          const directory = join(root, id);
          const coverageDir = join(directory, "coverage");
          mkdirSync(coverageDir, { recursive: true });
          const startedAt = new Date().toISOString();
          writeFileSync(
            join(directory, "started.json"),
            json({ started_at: startedAt, manifest_sha256: manifestSha256 }),
            { flag: "wx" },
          );
          const runtimeTargets = shard.targets.filter((target) => runtimeScope.includes(target));
          const distributed = options.distributed
            ? {
                distributed_ticket_sha256: options.distributed.ticketSha256,
                coordinator_commit_sha: options.distributed.commit,
                github_run_id: options.distributed.githubRunId,
              }
            : {};
          if (runtimeTargets.length === 0) {
            const receipt: CoverageShardReceipt = {
              version: 1,
              wave_id: wave.wave_id,
              run_id: runId,
              shard_id: id,
              manifest_sha256: manifestSha256,
              source_sha256: wave.source_freeze_sha256,
              base_config_sha256: wave.config_sha256,
              coverage_config_sha256: "",
              test_sha256: wave.test_freeze_sha256,
              target_digest_sha256: wave.target_digest_sha256,
              ...(options.distributed ? { lock_sha256: wave.lock_sha256 } : {}),
              targets: shard.targets,
              runtime_targets: [],
              type_only_targets: [...shard.targets],
              not_applicable: "type_only_ast",
              direct_target_evidence: [],
              ...distributed,
            };
            writeFileSync(join(directory, "receipt.json"), json(receipt), { flag: "wx" });
            return { receipt, native: undefined };
          }
          const exitCode = await runWithVerificationLog({
            root: verificationRunsRoot(repo),
            owner: `coverage:${wave.wave_id}:${runId}:${id}`,
            sourceDigest: wave.source_freeze_sha256,
            command: "bun",
            args: [
              join(repo, "apps/engine/scripts/check-coverage-floor.ts"),
              "--wave-manifest",
              manifestPath,
              "--shard",
              id,
            ],
            cwd: repo,
            env: {
              ...process.env,
              SUBKIT_COVERAGE_DIR: coverageDir,
              SUBKIT_COVERAGE_CONCURRENCY: coverageShardConcurrency(workers, shard.resource_tags),
              ...(behaviorReceipts.has(id)
                ? { SUBKIT_COVERAGE_BEHAVIOR_RECEIPT: behaviorReceipts.get(id)! }
                : {}),
            },
            timeoutMs,
          });
          if (exitCode !== 0) throw new Error(`${id} exited ${exitCode}`);
          assertUnchanged();
          const published = readPublishedCoverage(coverageDir);
          const receiptText = readFileSync(published.receiptPath, "utf8");
          const provenanceText = readFileSync(published.provenancePath, "utf8");
          const lcovText = readFileSync(published.lcovPath, "utf8");
          const rawReceipt = JSON.parse(receiptText) as { direct_target_evidence?: unknown };
          if (!Array.isArray(rawReceipt.direct_target_evidence))
            throw new Error(`native coverage receipt has no direct evidence: ${id}`);
          const proofs = rawReceipt.direct_target_evidence as Array<{
            target?: unknown;
            path?: unknown;
            sha256?: unknown;
          }>;
          const direct_target_evidence = proofs.map((proof) => {
            if (
              typeof proof.target !== "string" ||
              typeof proof.path !== "string" ||
              typeof proof.sha256 !== "string"
            )
              throw new Error(`native coverage receipt has invalid direct evidence: ${id}`);
            const path = join(published.runDir, proof.path);
            return {
              target: proof.target,
              path: proof.path,
              sha256: proof.sha256,
              lcov: readFileSync(path, "utf8"),
            };
          });
          const receipt: CoverageShardReceipt = {
            version: 1,
            wave_id: wave.wave_id,
            run_id: runId,
            shard_id: id,
            manifest_sha256: manifestSha256,
            source_sha256: wave.source_freeze_sha256,
            base_config_sha256: wave.config_sha256,
            test_sha256: wave.test_freeze_sha256,
            target_digest_sha256: wave.target_digest_sha256,
            ...(options.distributed ? { lock_sha256: wave.lock_sha256 } : {}),
            native_receipt_sha256: hash(receiptText),
            native_provenance_sha256: hash(provenanceText),
            native_lcov_sha256: hash(lcovText),
            coverage_config_sha256: (() => {
              const provenance = JSON.parse(provenanceText) as { config_sha256?: unknown };
              if (typeof provenance.config_sha256 !== "string")
                throw new Error(`native coverage provenance has no config digest: ${id}`);
              return provenance.config_sha256;
            })(),
            targets: shard.targets,
            runtime_targets: runtimeTargets,
            type_only_targets: shard.targets.filter((target) => !runtimeScope.includes(target)),
            direct_target_evidence,
            ...distributed,
          };
          writeFileSync(join(directory, "receipt.json"), json(receipt), { flag: "wx" });
          return {
            receipt,
            native: {
              id,
              evidence_root: coverageDir,
              latest: {
                path: published.latestPath,
                sha256: hash(published.latestContents),
                contents: published.latestContents,
              },
              receiptText,
              provenanceText,
              lcovText,
            },
          };
        }),
      );
      const failures: string[] = [];
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") failures.push(String(outcome.reason));
        else {
          receipts.push(outcome.value.receipt);
          if (outcome.value.native) native.push(outcome.value.native);
        }
      }
      if (failures.length > 0)
        throw new Error(`Coverage wave shard failure: ${failures.join("; ")}`);
    }
    assertUnchanged();
    if (options.shardIds) return root;
    const errors = validateCoverageShardUnion({
      wave,
      runId,
      manifestSha256,
      sourceSha256: wave.source_freeze_sha256,
      canonicalScope: entries.map((entry) => entry.path),
      runtimeScope,
      shards: receipts,
      native,
      repo,
      ...(options.distributed ? { distributed: options.distributed } : {}),
    });
    if (errors.length > 0) throw new Error(`Coverage union rejected: ${errors.join("; ")}`);
    const unionPath = join(root, "union.json");
    writeFileSync(
      unionPath,
      json({
        version: 1,
        wave_id: wave.wave_id,
        run_id: runId,
        manifest_sha256: manifestSha256,
        target_count: entries.length,
        shards: receipts.map((receipt) => ({
          id: receipt.shard_id,
          receipt_sha256: hash(json(receipt)),
        })),
        coverage: { line: 100, function: 100 },
        mutation_verification: "pending",
      }),
      { flag: "wx" },
    );
    return unionPath;
  } catch (error) {
    writeFileSync(join(root, "failed.json"), json({ error: String(error) }), { flag: "wx" });
    throw error;
  }
}

if (import.meta.main) {
  const options = parseMutationExecutorArgs(process.argv.slice(2));
  const manifestPath = resolve(REPO, options.manifest);
  if (options.mode === "run")
    console.log(
      await executeCoverageWave({ repo: REPO, manifestPath, timeoutMs: 6 * 60 * 60 * 1000 }),
    );
  else
    console.log(
      json(
        planMutationBatches(
          loadMutationWave(REPO, manifestPath).wave.shards,
          loadMutationWave(REPO, manifestPath).wave.worker_budget,
        ),
      ),
    );
}
