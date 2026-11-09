import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { verificationRunsRoot } from "../../../scripts/lib/verification-run-lifecycle.ts";
import { runWithVerificationLog } from "../../../scripts/run-with-verification-log.ts";
import { readPublishedCoverage } from "./audit/coverage-artifacts.ts";
import {
  type CoverageShardNative,
  type CoverageShardReceipt,
  validateCoverageShardUnion,
} from "./audit/coverage-union.ts";
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

export async function executeCoverageWave(options: {
  repo: string;
  manifestPath: string;
  timeoutMs: number;
}): Promise<string> {
  const { repo, manifestPath, timeoutMs } = options;
  const prepared = loadMutationWave(repo, manifestPath);
  const { wave, manifestText, entries } = prepared;
  const runtimeScope = runtimePureTargetPaths(entries);
  const manifestSha256 = hash(manifestText);
  const runId = `run-${randomUUID()}`;
  const root = join(repo, "reports/coverage/shards", wave.wave_id, runId);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "wave.json"), manifestText, { flag: "wx" });
  const batches = planMutationBatches(wave.shards, wave.worker_budget);
  const receipts: CoverageShardReceipt[] = [];
  const native: CoverageShardNative[] = [];
  const assertUnchanged = () => {
    const current = loadMutationWave(repo, manifestPath);
    if (hash(current.manifestText) !== manifestSha256)
      throw new Error("Coverage wave changed during execution");
  };
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
              targets: shard.targets,
              runtime_targets: [],
              type_only_targets: [...shard.targets],
              not_applicable: "type_only_ast",
              direct_target_evidence: [],
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
