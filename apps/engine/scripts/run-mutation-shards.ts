import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { verificationRunsRoot } from "../../../scripts/lib/verification-run-lifecycle.ts";
import { runWithVerificationLog } from "../../../scripts/run-with-verification-log.ts";
import { readMutationEquivalentManifest } from "./audit/mutation-floor.ts";
import { mutationClosureFiles, mutationTestInputs } from "./audit/mutation-inputs.ts";
import { planMutationBatches } from "./audit/mutation-scheduler.ts";
import { buildMutationShardConfig } from "./audit/mutation-shard-config.ts";
import {
  type MutationShardReceipt,
  type MutationShardUnionInput,
  validateMutationShardUnion,
} from "./audit/mutation-union.ts";
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

export async function executeMutationWave(options: {
  repo: string;
  manifestPath: string;
  timeoutMs: number;
}): Promise<string> {
  const { repo, manifestPath, timeoutMs } = options;
  const prepared = loadMutationWave(repo, manifestPath);
  const { wave, manifestText, entries, baseConfig, equivalents } = prepared;
  const runtimeScope = runtimePureTargetPaths(entries);
  const manifestSha256 = hash(manifestText);
  const runId = `run-${randomUUID()}`;
  const root = join(repo, "reports/mutation/runs", wave.wave_id, runId);
  mkdirSync(root, { recursive: true });
  const executionManifestPath = join(root, "wave.json");
  writeFileSync(executionManifestPath, manifestText, { flag: "wx" });
  const batches = planMutationBatches(wave.shards, wave.worker_budget);
  const workersByShard = Object.fromEntries(
    batches.flat().map((assignment) => [assignment.id, assignment.workers]),
  );
  const results: MutationShardUnionInput["shards"][number][] = [];
  const assertUnchanged = () => {
    if (hash(readFileSync(executionManifestPath)) !== manifestSha256)
      throw new Error("Immutable mutation wave changed during execution");
    const current = loadMutationWave(repo, manifestPath);
    if (hash(current.manifestText) !== manifestSha256)
      throw new Error("Mutation wave changed during execution");
  };
  for (const batch of batches) {
    assertUnchanged();
    const outcomes = await Promise.allSettled(
      batch.map(async ({ id, workers }) => {
        const shard = wave.shards.find((item) => item.id === id)!;
        const runtimeTargets = shard.targets.filter((target) => runtimeScope.includes(target));
        const directory = join(root, id);
        mkdirSync(directory);
        const startedAt = new Date().toISOString();
        if (runtimeTargets.length === 0) {
          const receipt: MutationShardReceipt = {
            version: 1,
            wave_id: wave.wave_id,
            run_id: runId,
            shard_id: id,
            manifest_sha256: manifestSha256,
            config_sha256: "",
            base_config_sha256: wave.config_sha256,
            report_sha256: "",
            source_sha256: wave.source_freeze_sha256,
            test_sha256: wave.test_freeze_sha256,
            target_digest_sha256: wave.target_digest_sha256,
            canonical_target_sha256: wave.target_digest_sha256,
            lock_sha256: wave.lock_sha256,
            equivalence_manifest_sha256: wave.equivalence_manifest_sha256,
            dynamic_import_ledger_sha256: wave.dynamic_import_ledger_sha256,
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            exit_code: 0,
            targets: shard.targets,
            runtime_targets: [],
            type_only_targets: [...shard.targets],
            not_applicable: "type_only_ast",
            workers,
          };
          const receiptText = json(receipt);
          writeFileSync(join(directory, "receipt.json"), receiptText, { flag: "wx" });
          return { id, receiptText, configText: "", reportText: "", exitCode: 0 };
        }
        const config = buildMutationShardConfig({
          base: baseConfig,
          waveId: wave.wave_id,
          runId,
          manifestPath: executionManifestPath,
          ...(wave.quality_policy_sha256 ? { repo } : {}),
          shard: { ...shard, targets: runtimeTargets },
          workers,
        });
        const configText = json(config);
        const configPath = join(directory, "stryker.json");
        writeFileSync(configPath, configText, { flag: "wx" });
        writeFileSync(
          join(directory, "started.json"),
          json({
            started_at: startedAt,
            manifest_sha256: manifestSha256,
            config_sha256: hash(configText),
          }),
          { flag: "wx" },
        );
        const exitCode = await runWithVerificationLog({
          root: verificationRunsRoot(repo),
          owner: `mutation:${wave.wave_id}:${runId}:${id}`,
          sourceDigest: wave.source_freeze_sha256,
          command: "node",
          args: [
            join(repo, "node_modules/@stryker-mutator/core/bin/stryker.js"),
            "run",
            configPath,
            "--force",
          ],
          cwd: repo,
          env: { ...process.env, SUBKIT_MUTATION_ORIGINAL_REPO: repo },
          timeoutMs,
        });
        assertUnchanged();
        const reportText = readFileSync(join(directory, "mutation.json"), "utf8");
        const receipt: MutationShardReceipt = {
          version: 1,
          wave_id: wave.wave_id,
          run_id: runId,
          shard_id: id,
          manifest_sha256: manifestSha256,
          config_sha256: hash(configText),
          base_config_sha256: wave.config_sha256,
          report_sha256: hash(reportText),
          source_sha256: wave.source_freeze_sha256,
          test_sha256: wave.test_freeze_sha256,
          target_digest_sha256: wave.target_digest_sha256,
          canonical_target_sha256: wave.target_digest_sha256,
          lock_sha256: wave.lock_sha256,
          equivalence_manifest_sha256: wave.equivalence_manifest_sha256,
          dynamic_import_ledger_sha256: wave.dynamic_import_ledger_sha256,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          exit_code: exitCode,
          targets: shard.targets,
          runtime_targets: runtimeTargets,
          type_only_targets: shard.targets.filter((target) => !runtimeScope.includes(target)),
          workers,
        };
        const receiptText = json(receipt);
        writeFileSync(join(directory, "receipt.json"), receiptText, { flag: "wx" });
        return { id, receiptText, configText, reportText, exitCode };
      }),
    );
    const failures: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") failures.push(String(outcome.reason));
      else {
        results.push(outcome.value);
        if (outcome.value.exitCode !== 0)
          failures.push(`${outcome.value.id} exited ${outcome.value.exitCode}`);
      }
    }
    if (failures.length > 0) {
      writeFileSync(join(root, "failed.json"), json({ failures }), { flag: "wx" });
      throw new Error(`Mutation wave failed; retained evidence at ${root}: ${failures.join("; ")}`);
    }
  }
  assertUnchanged();
  const errors = validateMutationShardUnion({
    wave,
    runId,
    manifestPath: executionManifestPath,
    baseConfig,
    canonicalScope: entries.map((entry) => entry.path),
    runtimeScope,
    sourceSha256: wave.source_freeze_sha256,
    testSha256: wave.test_freeze_sha256,
    workersByShard,
    shards: results,
    manifestSha256,
    equivalenceManifest: equivalents,
    repo,
    sourceSha256ForFile: (file) => hash(readFileSync(join(repo, file))),
  });
  if (errors.length > 0) {
    writeFileSync(join(root, "failed.json"), json({ phase: "mutation-union", errors }), {
      flag: "wx",
    });
    throw new Error(`Mutation union rejected: ${errors.join("; ")}`);
  }
  const unionPath = join(root, "union.json");
  writeFileSync(
    unionPath,
    json({
      version: 1,
      wave_id: wave.wave_id,
      run_id: runId,
      manifest_sha256: manifestSha256,
      target_count: entries.length,
      shards: results.map((result) => ({
        id: result.id,
        receipt_sha256: hash(result.receiptText),
      })),
      mutation_score: 100,
      coverage_verification: "pending",
    }),
    { flag: "wx" },
  );
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
