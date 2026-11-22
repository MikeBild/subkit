#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBoundedOutputLog } from "../../../scripts/lib/bounded-output-log.ts";
import {
  createVerificationRun,
  finalizeVerificationRun,
  verificationRunsRoot,
} from "../../../scripts/lib/verification-run-lifecycle.ts";
import { runIsolatedTestFile } from "../../subkit/src/tests/run-isolated-test-file.ts";
import {
  ACTIVE_MUTANT_ENV,
  activeMutantTarget,
  formatDeadlineKill,
  formatShardTestObservation,
  type MutantTestDeadlinePolicy,
  mutantTestDeadlineMs,
  parseShardArgs,
  parseShardTestHistory,
  parseTestBaselines,
  runShardTests,
  type ShardTestHistory,
  selectCanonicalCoreTests,
  selectShardMutationTests,
  shardTestImportDistance,
  type TestBaselines,
} from "./audit/core-tests.ts";
import { createClosureAnalysis } from "./audit/mutation-closure.ts";
import { writeMutationInfrastructureSentinel } from "./audit/mutation-infrastructure-sentinel.ts";
import { mutationClosureFiles, mutationTestInputs } from "./audit/mutation-inputs.ts";
import { provisionMutationRuntimeSnapshot } from "./audit/mutation-runtime-snapshot.ts";
import { validateParentMutationValidationTicket } from "./audit/mutation-validation-ticket.ts";
import {
  digestWaveFiles,
  readValidatedWaveManifest,
  validateWaveClosure,
  validateWaveFreeze,
} from "./audit/mutation-wave.ts";
import {
  assertCompletePureTargetInventory,
  canonicalPureTargetDigest,
  runtimePureTargetPaths,
} from "./audit/pure-targets.ts";
import { parseQualityShardPolicy } from "./audit/quality-shard-policy.ts";
import { QUALITY_SHARD_POLICY_PATH } from "./audit/quality-wave-manifest.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function recordMutationInfrastructureFailure(error: unknown): void {
  const ticketPath = process.env.SUBKIT_MUTATION_PARENT_TICKET_PATH;
  if (!ticketPath) return;
  try {
    writeMutationInfrastructureSentinel(ticketPath, String(error));
  } catch (sentinelError) {
    if ((sentinelError as NodeJS.ErrnoException).code !== "EEXIST") throw sentinelError;
  }
}

function advisoryShardTestOrderPath(shard: string, target?: string): string | undefined {
  const ticketPath = process.env.SUBKIT_MUTATION_PARENT_TICKET_PATH;
  if (!ticketPath) return undefined;
  const scope = target === undefined ? shard : `${shard}\0${target}`;
  const key = createHash("sha256").update(`${ticketPath}\0${scope}`).digest("hex").slice(0, 32);
  return join(tmpdir(), `subkit-mutation-test-order-${key}.jsonl`);
}

function mutationRunFile(directory: string, shard: string): string | undefined {
  const ticketPath = process.env.SUBKIT_MUTATION_PARENT_TICKET_PATH;
  if (!ticketPath) return undefined;
  return join(dirname(ticketPath), directory, `${shard}.jsonl`);
}

function readTestBaselines(path: string | undefined): TestBaselines {
  if (!path) return new Map();
  try {
    return parseTestBaselines(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
}

function appendRunFile(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, line, { mode: 0o600 });
}

function readShardTestHistory(path: string | undefined): ShardTestHistory {
  if (!path) return new Map();
  try {
    return parseShardTestHistory(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
}

function recordShardTestObservation(
  path: string | undefined,
  observation: { test: string; durationMs: number; failed: boolean },
): void {
  if (!path) return;
  try {
    appendFileSync(path, formatShardTestObservation(observation), { mode: 0o600 });
  } catch {
    return;
  }
}

const args = parseShardArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(args.error);
  process.exit(1);
}
let selected: string[];
let passthrough: string[];
let directTests: string[] = [];
let mutatedTarget: string | undefined;
const testDistances = new Map<string, number>();
let verificationRepo = REPO;
let mutantDeadlinePolicy: MutantTestDeadlinePolicy | undefined;
if (args.mode === "shard") {
  if (args.passthrough.some((arg) => arg !== "--list")) {
    console.error("shard mode accepts no test narrowing flags or paths");
    process.exit(1);
  }
  let manifest: ReturnType<typeof readValidatedWaveManifest>;
  let cached: ReturnType<typeof validateParentMutationValidationTicket>;
  try {
    cached = validateParentMutationValidationTicket({
      repo: process.env.SUBKIT_MUTATION_ORIGINAL_REPO ?? REPO,
      sandboxRepo: REPO,
      manifestPath: isAbsolute(args.manifest) ? args.manifest : join(REPO, args.manifest),
      shardId: args.shard,
      env: process.env,
      reuseFileStamp: true,
    });
    if (cached && !cached.wave.runtime_artifact_digest_sha256)
      throw new Error("parent mutation validation ticket wave lacks runtime artifact digest");
    if (cached?.wave.runtime_artifact_digest_sha256 && !process.argv.includes("--list"))
      provisionMutationRuntimeSnapshot({
        sandboxRepo: REPO,
        snapshotPath: join(
          resolve(process.env.SUBKIT_MUTATION_ORIGINAL_REPO ?? REPO),
          cached.ticket.runtime_snapshot_path,
        ),
        snapshotSha256: cached.ticket.runtime_snapshot_sha256,
        sealSha256: cached.ticket.runtime_snapshot_seal_sha256,
        expected: {
          wave_id: cached.wave.wave_id,
          run_id: cached.ticket.run_id,
          source_freeze_sha256: cached.wave.source_freeze_sha256,
          manifest_sha256: cached.ticket.manifest_sha256,
          artifact_digest_sha256: cached.wave.runtime_artifact_digest_sha256,
        },
      });
  } catch (error) {
    if (!process.argv.includes("--list")) recordMutationInfrastructureFailure(error);
    throw error;
  }
  if (cached) {
    manifest = cached.wave;
    verificationRepo = resolve(process.env.SUBKIT_MUTATION_ORIGINAL_REPO ?? REPO);
  } else {
    const knownFiles = mutationClosureFiles(REPO);
    const entries = assertCompletePureTargetInventory(knownFiles);
    const typeOnlyTargets = entries
      .filter((entry) => entry.runtime_kind === "type_only")
      .map((entry) => entry.path);
    try {
      manifest = readValidatedWaveManifest({
        text: readFileSync(
          isAbsolute(args.manifest) ? args.manifest : join(REPO, args.manifest),
          "utf8",
        ),
        canonical_targets: entries.map((target) => target.path),
        canonical_target_digest: canonicalPureTargetDigest(entries),
        known_files: knownFiles,
        type_only_targets: typeOnlyTargets,
      });
    } catch (error) {
      console.error((error as Error).message);
      process.exit(1);
    }
    const freezeRepo = process.env.SUBKIT_MUTATION_ORIGINAL_REPO ?? REPO;
    const closureErrors = validateWaveClosure({
      repo: freezeRepo,
      wave: manifest,
      files: knownFiles,
      type_only_targets: typeOnlyTargets,
    });
    if (closureErrors.length > 0) {
      console.error(`incomplete reviewed closure:\n${closureErrors.join("\n")}`);
      process.exit(1);
    }
    const stale = validateWaveFreeze({
      repo: freezeRepo,
      manifest,
      runtime_inputs: mutationTestInputs(freezeRepo),
    });
    if (stale.length > 0) {
      console.error(`stale or manipulated shard freeze: ${stale.join(", ")}`);
      process.exit(1);
    }
  }
  const shard = manifest.shards.find((entry) => entry.id === args.shard);
  if (!shard) {
    console.error(`shard not found: ${args.shard}`);
    process.exit(1);
  }
  const policyRepo = resolve(process.env.SUBKIT_MUTATION_ORIGINAL_REPO ?? REPO);
  if (
    manifest.quality_policy_sha256 !== undefined &&
    digestWaveFiles(policyRepo, [QUALITY_SHARD_POLICY_PATH]) !== manifest.quality_policy_sha256
  ) {
    console.error("quality shard policy differs from the frozen wave");
    process.exit(1);
  }
  const policy =
    manifest.quality_policy_sha256 === undefined
      ? undefined
      : parseQualityShardPolicy(
          JSON.parse(readFileSync(join(policyRepo, QUALITY_SHARD_POLICY_PATH), "utf8")),
          manifest.shards.map((entry) => entry.id),
        );
  const radius = policy?.mutation_test_radius;
  mutantDeadlinePolicy = policy?.mutant_test_deadline;
  const shardTests = selectShardMutationTests(
    shard.tests.filter((test) => test.execution !== "external_runtime"),
    radius,
  );
  selected = shardTests.map((test) => test.path);
  mutatedTarget = activeMutantTarget(
    shard.targets,
    (path) => {
      try {
        return readFileSync(join(REPO, path), "utf8");
      } catch {
        return null;
      }
    },
    process.env[ACTIVE_MUTANT_ENV],
  );
  directTests = shardTests
    .filter(
      (test) =>
        test.kind === "direct" &&
        (mutatedTarget === undefined || test.covers_targets.includes(mutatedTarget)),
    )
    .map((test) => test.path);
  for (const test of shardTests) {
    const distance = shardTestImportDistance(test.rationale);
    if (distance !== undefined) testDistances.set(test.path, distance);
  }
  passthrough = args.passthrough;
} else {
  const files = mutationClosureFiles(REPO);
  const targets = assertCompletePureTargetInventory(files);
  const readText = (path: string) => {
    try {
      return readFileSync(join(REPO, path), "utf8");
    } catch {
      return null;
    }
  };
  const analysis = createClosureAnalysis({
    files,
    readText,
    tsconfig: readText("tsconfig.json") ?? "{}",
    cockpitTsconfig: readText("apps/cockpit/tsconfig.json") ?? "{}",
  });
  selected = selectCanonicalCoreTests(
    analysis.testFiles,
    runtimePureTargetPaths(targets),
    analysis.reverse,
  );
  passthrough = args.passthrough;
}
const tests = selected.map((p) => `./${p}`);
const verificationOwner =
  args.mode === "shard" ? `core-test-runner:${args.shard}` : "core-test-runner";

const activeMutant = process.env[ACTIVE_MUTANT_ENV];

async function runCoreTest(
  file: string,
  mutantDeadline?: { deadlineMs: number; baselineMs: number; ledgerPath: string },
): Promise<void> {
  let childFailure: unknown;
  let actualChildFailure = false;
  let runDirectory: string | undefined;
  try {
    const run = createVerificationRun({
      root: verificationRunsRoot(verificationRepo),
      owner: verificationOwner,
      logPath: "runner.log",
    });
    runDirectory = run.directory;
    const logPath = join(run.directory, "runner.log");
    const resultPath = join(run.directory, "result.json");
    writeFileSync(logPath, "", { mode: 0o600, flag: "wx" });
    const output = createBoundedOutputLog(logPath);
    let terminal:
      | { exitCode: number | null; signal: string | null; timedOut: boolean; error: string | null }
      | undefined;
    let outputFailed = false;
    try {
      await runIsolatedTestFile(file, {
        cwd: REPO,
        ...(mutantDeadline === undefined ? {} : { deadlineMs: mutantDeadline.deadlineMs }),
        env: { SKIP_DOCKER: "1" },
        onOutput: (chunk, stream) => {
          try {
            output.append(chunk, stream);
          } catch (error) {
            outputFailed = true;
            throw error;
          }
        },
        onTerminal: (outcome) => {
          terminal = outcome;
        },
      });
    } catch (error) {
      childFailure = error;
    }
    if (outputFailed || terminal === undefined || terminal.error !== null)
      throw new Error(
        outputFailed
          ? "core test output sink failed"
          : `core test runner failed: ${terminal?.error}`,
      );
    actualChildFailure = terminal.exitCode !== 0 || terminal.timedOut;
    if (terminal.timedOut && mutantDeadline !== undefined && activeMutant !== undefined)
      appendRunFile(
        mutantDeadline.ledgerPath,
        formatDeadlineKill({
          mutant: activeMutant,
          test: file,
          deadlineMs: mutantDeadline.deadlineMs,
          baselineMs: mutantDeadline.baselineMs,
        }),
      );
    if (childFailure !== undefined && !actualChildFailure)
      throw new Error(`core test runner cleanup failed: ${childFailure}`);
    const status =
      childFailure === undefined && terminal.exitCode === 0 && !terminal.timedOut
        ? "passed"
        : "failed";
    const snapshot = output.snapshot();
    writeFileSync(
      resultPath,
      `${JSON.stringify(
        {
          status,
          test: file,
          terminal,
          output: {
            total_bytes: snapshot.totalBytes,
            persisted_bytes: snapshot.persistedBytes,
            truncated: snapshot.truncated,
          },
          error: childFailure === undefined ? null : String(childFailure),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600, flag: "wx" },
    );
    finalizeVerificationRun(run, { status, resultPath: "result.json", logPath: "runner.log" });
    if (childFailure !== undefined) {
      const tail = snapshot.tail.toString("utf8");
      if (tail) console.error(tail);
      throw childFailure;
    }
  } catch (error) {
    if (error === childFailure && actualChildFailure) throw error;
    const ticketPath = process.env.SUBKIT_MUTATION_PARENT_TICKET_PATH;
    if (ticketPath) writeMutationInfrastructureSentinel(ticketPath, String(error));
    throw error;
  } finally {
    if (activeMutant !== undefined && runDirectory !== undefined)
      rmSync(runDirectory, { recursive: true, force: true });
  }
}

if (process.argv.includes("--list")) {
  console.log(tests.join("\n"));
  process.exit(0);
}
if (tests.length === 0) {
  console.error("no core tests found");
  process.exit(1);
}
if (args.mode === "shard") {
  try {
    const historyPath = advisoryShardTestOrderPath(args.shard);
    const targetHistoryPath =
      mutatedTarget === undefined
        ? undefined
        : advisoryShardTestOrderPath(args.shard, mutatedTarget);
    const shardHistory = readShardTestHistory(historyPath);
    const baselinePath = mutationRunFile("test-baselines", args.shard);
    const ledgerPath = mutationRunFile("deadline-kills", args.shard);
    const baselines = activeMutant === undefined ? new Map() : readTestBaselines(baselinePath);
    await runShardTests(
      selected,
      async (path) => {
        const startedAt = performance.now();
        let failed = false;
        try {
          const baselineMs = baselines.get(path);
          const deadlineMs = mutantTestDeadlineMs(baselineMs, mutantDeadlinePolicy);
          await runCoreTest(
            path,
            deadlineMs === undefined || baselineMs === undefined || ledgerPath === undefined
              ? undefined
              : { deadlineMs, baselineMs, ledgerPath },
          );
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          const observation = { test: path, durationMs: performance.now() - startedAt, failed };
          if (activeMutant === undefined && !failed && baselinePath !== undefined)
            appendRunFile(baselinePath, formatShardTestObservation(observation));
          recordShardTestObservation(historyPath, observation);
          recordShardTestObservation(targetHistoryPath, observation);
        }
      },
      process.env.SUBKIT_MUTATION_FULL_CLOSURE === "1",
      directTests,
      shardHistory,
      testDistances,
      readShardTestHistory(targetHistoryPath),
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  process.exit(0);
}
const result = spawnSync("bun", ["test", "--reporter=dots", ...tests, ...passthrough], {
  cwd: REPO,
  env: { ...process.env, SKIP_DOCKER: "1" },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
