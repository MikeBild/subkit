#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localDatabaseUrl } from "../../../scripts/lib/local-database-url.ts";
import { startOwnedChild } from "../../../scripts/lib/owned-process-watchdog.ts";
import {
  createIsolatedTestHome,
  removeIsolatedTestHome,
} from "../../sk/src/tests/isolated-test-home.ts";
import { runIsolatedTestFile } from "../../sk/src/tests/run-isolated-test-file.ts";
import { boundedConcurrency, runBoundedInOrder } from "./audit/bounded-runner.ts";
import {
  type CoverageRunLease,
  createCoverageRunLease,
  createDirectTargetProof,
  type DirectTargetProof,
  type InputSnapshot,
  inputsChanged,
  installCoverageLeaseSignalRetention,
  prepareRawLcov,
  publishCoverageReceipt,
  removeCoverageRawRunAfterReceipt,
  retainCoverageRawRun,
  snapshotInputs,
} from "./audit/coverage-artifacts.ts";
import { validateCoverageBehaviorProof } from "./audit/coverage-behavior-proof.ts";
import {
  coverageDatabaseUrl,
  coverageExecutionContext,
  coverageTestEnvironment,
} from "./audit/coverage-environment.ts";
import {
  aggregateByPrefix,
  type CoverageRun,
  type FloorEntry,
  judgeFile,
  parseFloorFile,
  relatedTests,
  resolveFileFloors,
  testCandidates,
} from "./audit/coverage-floor.ts";
import {
  planCoverageBehaviorGroups,
  planCoverageShardExecution,
} from "./audit/coverage-shard-plan.ts";
import { listFiles } from "./audit/files.ts";
import { coverageRows, type LcovRecord, mergeLcov, parseLcov, renderLcov } from "./audit/lcov.ts";
import { createClosureAnalysis, directTestPaths } from "./audit/mutation-closure.ts";
import { mutationClosureFiles, mutationTestInputs } from "./audit/mutation-inputs.ts";
import { PURE_MUTATION_TARGETS } from "./audit/mutation-scope.ts";
import {
  type MutationWaveManifest,
  readValidatedWaveManifest,
  validateWaveClosure,
  validateWaveFreeze,
} from "./audit/mutation-wave.ts";
import {
  assertCompletePureTargetInventory,
  canonicalPureTargetDigest,
} from "./audit/pure-targets.ts";

const __filename = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(__filename), "..", "..", "..");
const COVERAGE_DIR = process.env.SUBKIT_COVERAGE_DIR
  ? resolve(process.env.SUBKIT_COVERAGE_DIR)
  : join(REPO, "reports/coverage");
const COVERAGE_INPUT_ROOTS = ["apps/cockpit/src", "apps/engine/src", "apps/sk/src", "packages"];
const COVERAGE_INPUT_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|wat)$/;
const COVERAGE_CONFIG_INPUTS = [
  "apps/engine/.coverage-floor.json",
  "apps/engine/scripts/check-coverage-floor.ts",
  "apps/engine/scripts/audit/coverage-artifacts.ts",
  "apps/engine/scripts/audit/coverage-behavior-proof.ts",
  "apps/engine/scripts/audit/coverage-environment.ts",
  "apps/engine/scripts/audit/coverage-publication.ts",
  "apps/engine/scripts/audit/bounded-runner.ts",
  "apps/engine/scripts/audit/coverage-floor.ts",
  "apps/engine/scripts/audit/files.ts",
  "apps/engine/scripts/audit/lcov.ts",
  "apps/engine/scripts/audit/mutation-scope.ts",
  "apps/engine/scripts/audit/pure-targets.ts",
  "apps/engine/scripts/audit/ratchets.ts",
  "apps/engine/scripts/audit/rules.ts",
  "scripts/lib/local-database-url.ts",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  "tsconfig.base.json",
  "apps/cockpit/tsconfig.json",
];

interface CoverageInvocation {
  tests: string[];
  direct_targets?: readonly string[];
  grouping: "per_test" | "per_target";
  records: LcovRecord[];
}

const coverageRecords: LcovRecord[] = [];
const coverageInvocations: CoverageInvocation[] = [];
let coverageLease: CoverageRunLease | undefined;
let disposeCoverageSignalRetention: (() => void) | undefined;
let waveContext:
  | {
      manifest: MutationWaveManifest;
      shardId: string;
      manifestSha256: string;
      tests: Map<string, string[]>;
      typeOnlyTargets: ReadonlySet<string>;
      resourceTags: readonly string[];
    }
  | undefined;
let waveDatabaseUrl: string | undefined;
const canonicalTestsByTarget = new Map<string, string[]>();
let behaviorEvidence: { sha256: string; text: string } | undefined;

const coverageInputFiles = (): string[] => [
  ...COVERAGE_INPUT_ROOTS.flatMap((root) =>
    listFiles(join(REPO, root), (file) => COVERAGE_INPUT_FILE.test(file)).map((file) =>
      relative(REPO, file),
    ),
  ),
  ...COVERAGE_CONFIG_INPUTS,
];
const coverageInputsBefore = snapshotInputs(REPO, coverageInputFiles());

const isSource = (p: string) =>
  p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts") && !p.includes("/tests/");

function digest(parts: readonly (string | Uint8Array)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function testFilesFor(targets: readonly string[]): string[] {
  const tests = new Set<string>();
  for (const target of targets) {
    const absolute = join(REPO, target);
    if (!existsSync(absolute)) continue;
    if (statSync(absolute).isDirectory()) {
      for (const file of listFiles(absolute, (candidate) =>
        /\.(?:test|spec)\.tsx?$/.test(candidate),
      ))
        tests.add(relative(REPO, file));
    } else if (/\.(?:test|spec)\.tsx?$/.test(target)) tests.add(target);
  }
  return [...tests].sort();
}

function invalidDeclaredTests(tests: readonly string[]): string[] {
  return tests.filter((test) => {
    const path = join(REPO, test);
    return !existsSync(path) || !statSync(path).isFile() || !/\.(?:test|spec)\.tsx?$/.test(test);
  });
}

function currentCoverageTestEnvironment(): NodeJS.ProcessEnv {
  return coverageTestEnvironment(process.env, waveDatabaseUrl ?? localDatabaseUrl(process.env));
}

export function testUsesModuleMock(test: string): boolean {
  return readFileSync(join(REPO, test), "utf8").includes("mock.module(");
}

interface GroupCoverageResult {
  group: string[];
  lcovPath: string;
  error?: string;
}

function readChildOutput(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    let output = "";
    stream.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    stream.once("error", reject);
    stream.once("end", () => resolve(output));
  });
}

async function runCoverageGroup(
  group: string[],
  lcovPath: string,
  grouping: CoverageInvocation["grouping"],
  index: number,
  total: number,
): Promise<GroupCoverageResult> {
  console.log(`COVERAGE ${grouping} [${index + 1}/${total}] ${group.join(" ")}`);
  const home = createIsolatedTestHome();
  try {
    const child = startOwnedChild(
      "bun",
      [
        "test",
        "--max-concurrency",
        "1",
        "--timeout",
        "120000",
        ...group.map((test) => `./${test}`),
        "--coverage",
        "--coverage-reporter=lcov",
        `--coverage-dir=${dirname(lcovPath)}`,
      ],
      {
        cwd: REPO,
        env: {
          ...currentCoverageTestEnvironment(),
          HOME: home.path,
          USERPROFILE: home.path,
          SUBKIT_TEST_HOME: home.path,
          SUBKIT_TEST_HOME_TOKEN: home.token,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
      300_000,
      5_000,
    );
    const stdout = readChildOutput(child.child.stdout);
    const stderr = readChildOutput(child.child.stderr);
    const [outcome, out, err] = await Promise.all([child.completed, stdout, stderr]);
    if (outcome.timedOut) {
      return {
        group,
        lcovPath,
        error: `coverage command timed out after 300000ms for ${group.join(", ")}`,
      };
    }
    if (outcome.exitCode !== 0 || outcome.error) {
      const detail = `${out}\n${err}`.trim().slice(-4_000);
      return {
        group,
        lcovPath,
        error: `coverage command exited with status ${outcome.exitCode ?? "unknown"} for ${group.join(", ")}${detail ? `\n${detail}` : ""}`,
      };
    }
    if (!existsSync(lcovPath)) {
      return {
        group,
        lcovPath,
        error: `coverage command wrote no LCOV report for ${group.join(", ")}`,
      };
    }
    return { group, lcovPath };
  } finally {
    removeIsolatedTestHome(home);
  }
}

async function runCoverage(
  targets: readonly string[],
  grouping: "per_test" | "per_target" = "per_test",
  directTargets: readonly string[] = [],
  directTargetsByTest?: ReadonlyMap<string, readonly string[]>,
): Promise<CoverageRun> {
  const tests = testFilesFor(targets);
  if (tests.length === 0) return { error: `no test files found for ${targets.join(", ")}` };
  const records: LcovRecord[] = [];
  const groups = grouping === "per_target" ? [tests] : tests.map((test) => [test]);
  const preparations: Array<{ group: string[]; lcovPath: string }> = [];
  for (const group of groups) {
    for (const test of group) {
      if (testUsesModuleMock(test)) {
        return { error: `${test} uses mock.module; pure target coverage needs a contract runner` };
      }
    }
    if (!coverageLease) return { error: "coverage raw run lease was not initialized" };
    preparations.push({ group, lcovPath: prepareRawLcov(coverageLease) });
  }
  let completed: GroupCoverageResult[];
  try {
    completed = await runBoundedInOrder(
      preparations,
      grouping === "per_target" ? 1 : boundedConcurrency(process.env.SUBKIT_COVERAGE_CONCURRENCY),
      async ({ group, lcovPath }, index) => {
        const result = await runCoverageGroup(group, lcovPath, grouping, index, groups.length);
        if (result.error) throw new Error(result.error);
        return result;
      },
    );
  } catch (error) {
    return {
      error: `coverage runner failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  for (const completedGroup of completed) {
    if (completedGroup.error) return { error: completedGroup.error };
    const parsed = parseLcov(readFileSync(completedGroup.lcovPath, "utf8"), REPO);
    if ("error" in parsed) return { error: `${completedGroup.group.join(", ")}: ${parsed.error}` };
    records.push(...parsed);
    coverageRecords.push(...parsed);
    const invocationTargets = directTargetsByTest
      ? [...new Set(completedGroup.group.flatMap((test) => directTargetsByTest.get(test) ?? []))]
      : directTargets;
    coverageInvocations.push({
      tests: completedGroup.group,
      ...(invocationTargets.length === 0 ? {} : { direct_targets: invocationTargets }),
      grouping,
      records: parsed,
    });
  }
  return { rows: coverageRows(mergeLcov(records)) };
}

async function runClosureBehaviorTests(tests: readonly string[]): Promise<string | undefined> {
  for (const test of tests) {
    try {
      await runIsolatedTestFile(test, {
        cwd: REPO,
        deadlineMs: 300_000,
        env: currentCoverageTestEnvironment(),
      });
    } catch (error) {
      return `${test}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return undefined;
}

function verifiedBehaviorReceipt(tests: readonly string[]): string | undefined {
  const path = process.env.SUBKIT_COVERAGE_BEHAVIOR_RECEIPT;
  if (path === undefined) return undefined;
  if (!waveContext) return "behavior receipt is only valid for a wave shard";
  let text: string;
  try {
    text = readFileSync(path, "utf8");
    const sha256 = createHash("sha256").update(text).digest("hex");
    validateCoverageBehaviorProof({
      text,
      sha256,
      repo: REPO,
      wave_id: waveContext.manifest.wave_id,
      manifest_sha256: waveContext.manifestSha256,
      source_sha256: waveContext.manifest.source_freeze_sha256,
      test_sha256: waveContext.manifest.test_freeze_sha256,
      config_sha256: waveContext.manifest.config_sha256,
      context_sha256: digest([
        JSON.stringify(
          coverageExecutionContext(currentCoverageTestEnvironment(), waveContext.resourceTags),
          null,
          2,
        ),
        "\n",
      ]),
      resource_tags: waveContext.resourceTags,
      tests,
      executed_tests:
        planCoverageBehaviorGroups({
          shards: waveContext.manifest.shards.map((shard) => ({
            ...shard,
            targets: shard.targets.filter((target) => !waveContext!.typeOnlyTargets.has(target)),
          })),
          usesModuleMock: testUsesModuleMock,
        }).find(
          (group) =>
            JSON.stringify(group.resource_tags) === JSON.stringify(waveContext!.resourceTags),
        )?.tests ?? [],
    });
    behaviorEvidence = { sha256, text };
  } catch {
    return "behavior receipt is unreadable";
  }
  return "";
}

async function persistCoverageArtifact(): Promise<string | undefined> {
  let coverageInputsAfter: InputSnapshot;
  try {
    coverageInputsAfter = snapshotInputs(REPO, coverageInputFiles());
  } catch (error) {
    return `coverage input snapshot failed after test execution: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (inputsChanged(coverageInputsBefore, coverageInputsAfter))
    return "coverage inputs changed while coverage was running; refusing to write a stale coverage receipt";
  if (waveContext) {
    const stale = validateWaveFreeze({
      repo: REPO,
      manifest: waveContext.manifest,
      runtime_inputs: mutationTestInputs(REPO),
    });
    if (stale.length > 0)
      return `wave inputs changed while coverage was running: ${stale.join(", ")}`;
  }
  const merged = mergeLcov(coverageRecords);
  if (merged.length === 0) return "coverage produced no LCOV records";
  const scope = merged.map((record) => record.file);
  const tests = coverageInvocations.flatMap((run) => run.tests).sort();
  const sourceDigest = digest(
    scope.flatMap((file) => [file, "\0", readFileSync(join(REPO, file)), "\0"]),
  );
  const configFiles = COVERAGE_CONFIG_INPUTS;
  const configDigest = digest(
    configFiles.flatMap((file) => [file, "\0", readFileSync(join(REPO, file)), "\0"]),
  );
  const testDigest = digest(
    tests.flatMap((file) => [file, "\0", readFileSync(join(REPO, file)), "\0"]),
  );
  if (!coverageLease) return "coverage raw run lease was not initialized";
  const directRecordsByTarget = new Map<string, LcovRecord[]>();
  for (const invocation of coverageInvocations) {
    for (const target of invocation.direct_targets ?? []) {
      const records = directRecordsByTarget.get(target) ?? [];
      records.push(...invocation.records.filter((record) => record.file === target));
      directRecordsByTarget.set(target, records);
    }
  }
  const directTargetProofs: DirectTargetProof[] = [];
  for (const [target, records] of directRecordsByTarget) {
    const directRecords = mergeLcov(records);
    if (directRecords.length === 0)
      return `direct target coverage produced no LCOV record: ${target}`;
    directTargetProofs.push(createDirectTargetProof(target, renderLcov(directRecords)));
  }
  try {
    await publishCoverageReceipt({
      coverageDir: COVERAGE_DIR,
      lease: coverageLease,
      lcov: renderLcov(merged),
      provenance: {
        version: 4,
        created_at: new Date().toISOString(),
        config_sha256: configDigest,
        source_sha256: sourceDigest,
        test_sha256: testDigest,
        scope,
        tests,
        runtime_inputs: coverageInputsBefore.files,
        runtime_sha256: coverageInputsBefore.sha256,
        function_coverage: {
          source: "bun_lcov_fnf_fnh",
          subsystem_metric:
            "conservative_lower_bound: max(FNH) / max(FNF) per source file across isolated test processes, then source-count weighted aggregate",
          per_target_metric: "single_process_summary: FNH / FNF from one per-target invocation",
        },
        direct_target_evidence: directTargetProofs.map((proof) => ({
          target: proof.target,
          path: proof.relativePath,
          sha256: proof.sha256,
        })),
        ...(behaviorEvidence ? { behavior_evidence: behaviorEvidence } : {}),
        ...(waveContext
          ? {
              wave_id: waveContext.manifest.wave_id,
              shard_id: waveContext.shardId,
              manifest_sha256: waveContext.manifestSha256,
              wave_source_freeze_sha256: waveContext.manifest.source_freeze_sha256,
              wave_test_freeze_sha256: waveContext.manifest.test_freeze_sha256,
              wave_target_digest_sha256: waveContext.manifest.target_digest_sha256,
              wave_base_config_sha256: waveContext.manifest.config_sha256,
            }
          : {}),
        runs: coverageInvocations.map(({ records: _records, ...run }) => run),
      },
      directTargetProofs,
    });
  } catch (error) {
    return `coverage receipt persistence failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return undefined;
}

function testsFor(file: string, floor: FloorEntry): string[] {
  const canonicalTests = canonicalTestsByTarget.get(file);
  if (canonicalTests) return [...new Set([...canonicalTests, ...(floor.tests ?? [])])].sort();
  if (floor.tests && floor.tests.length > 0) return floor.tests;
  const direct = testCandidates(file).filter((candidate) => existsSync(join(REPO, candidate)));
  const directory = join(REPO, dirname(file));
  const stem =
    file
      .split("/")
      .at(-1)
      ?.replace(/\.tsx?$/, "") ?? file;
  const related = new RegExp(
    `^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[.-][^/]+\\.test\\.tsx?$`,
  );
  const siblingTests = [directory, join(directory, "tests"), join(directory, "__tests__")].flatMap(
    (testDirectory) =>
      existsSync(testDirectory)
        ? readdirSync(testDirectory)
            .filter((name) => related.test(name))
            .map((name) => relative(REPO, join(testDirectory, name)))
        : [],
  );
  const selected = [...new Set([...direct, ...siblingTests])].sort();
  if (selected.length > 0) return selected;
  if (file.startsWith("packages/shared/src/")) {
    return listFiles(join(REPO, "packages/shared/src"), (candidate) =>
      /\.(?:test|spec)\.tsx?$/.test(candidate),
    ).map((candidate) => relative(REPO, candidate));
  }
  const siblings = readdirSync(join(REPO, dirname(file)));
  return [...new Set([...direct, ...relatedTests(file, siblings)])];
}

const parsed = parseFloorFile(
  JSON.parse(readFileSync(join(REPO, "apps/engine/.coverage-floor.json"), "utf8")),
);
if ("errors" in parsed) {
  console.error(`.coverage-floor.json invalid:\n  ${parsed.errors.join("\n  ")}`);
  process.exit(1);
}
const { floors } = parsed;
const cliArgs = process.argv.slice(2);
if (cliArgs[0] === "--wave-manifest") {
  if (
    cliArgs.length !== 4 ||
    cliArgs[0] !== "--wave-manifest" ||
    cliArgs[2] !== "--shard" ||
    !isAbsolute(cliArgs[1]!) ||
    !cliArgs[3]
  ) {
    console.error("usage: check-coverage-floor.ts [--wave-manifest <absolute> --shard <id>]");
    process.exit(1);
  }
  const waveFiles = mutationClosureFiles(REPO);
  const known = waveFiles;
  const entries = assertCompletePureTargetInventory(known);
  const text = readFileSync(cliArgs[1]!, "utf8");
  const typeOnly = entries
    .filter((entry) => entry.runtime_kind === "type_only")
    .map((entry) => entry.path);
  const manifest = readValidatedWaveManifest({
    text,
    canonical_targets: entries.map((entry) => entry.path),
    canonical_target_digest: canonicalPureTargetDigest(entries),
    known_files: known,
    type_only_targets: typeOnly,
  });
  const stale = validateWaveFreeze({
    repo: REPO,
    manifest,
    runtime_inputs: mutationTestInputs(REPO),
  });
  if (stale.length > 0) {
    console.error(`stale coverage wave: ${stale.join(", ")}`);
    process.exit(1);
  }
  const closure = validateWaveClosure({
    repo: REPO,
    wave: manifest,
    files: waveFiles,
    type_only_targets: typeOnly,
  });
  if (closure.length > 0) {
    console.error(`incomplete coverage wave closure: ${closure.join("; ")}`);
    process.exit(1);
  }
  const shard = manifest.shards.find((entry) => entry.id === cliArgs[3]);
  if (!shard) {
    console.error(`wave shard not found: ${cliArgs[3]}`);
    process.exit(1);
  }
  const database = coverageDatabaseUrl(process.env, shard.resource_tags);
  if (database.error) {
    console.error(database.error);
    process.exit(1);
  }
  waveDatabaseUrl = database.url;
  waveContext = {
    manifest,
    shardId: shard.id,
    manifestSha256: digest([text]),
    tests: new Map(shard.targets.map((target) => [target, shard.tests.map((test) => test.path)])),
    resourceTags: [...shard.resource_tags].sort(),
    typeOnlyTargets: new Set(
      entries.filter((entry) => entry.runtime_kind === "type_only").map((entry) => entry.path),
    ),
  };
}
if (cliArgs.some((arg) => arg.startsWith("--")) && !waveContext) {
  console.error(
    "usage: check-coverage-floor.ts [targets...] | --wave-manifest <absolute> --shard <id>",
  );
  process.exit(1);
}
coverageLease = createCoverageRunLease(COVERAGE_DIR);
disposeCoverageSignalRetention = installCoverageLeaseSignalRetention(coverageLease);

const want = waveContext ? [...waveContext.tests.keys()] : [...process.argv.slice(2)];
const wanted = (name: string): boolean =>
  want.length === 0 ||
  want.some((w) => w === name || w === name.split("/").pop() || name.startsWith(`${w}/`));

interface Result {
  target: string;
  status: "PASS" | "FAIL" | "SKIP";
  message: string;
}
const results: Result[] = [];

for (const [subsystem, floor] of Object.entries(floors.subsystems)) {
  if (!wanted(subsystem)) continue;
  if (floor.line_min === 0 && floor.function_min === 0) {
    results.push({
      target: subsystem,
      status: "SKIP",
      message: `floor=line ${floor.line_min}/function ${floor.function_min} (deferred — see rationale)`,
    });
    continue;
  }
  if (listFiles(join(REPO, subsystem), isSource).length === 0) {
    results.push({
      target: subsystem,
      status: "FAIL",
      message: "no source files under this directory",
    });
    continue;
  }
  const extraTests = floor.tests ?? [];
  const invalidTests = invalidDeclaredTests(extraTests);
  if (invalidTests.length > 0) {
    results.push({
      target: subsystem,
      status: "FAIL",
      message: `declared subsystem tests are missing or not test files: ${invalidTests.join(", ")}`,
    });
    continue;
  }
  const coverage = await runCoverage([subsystem, ...extraTests]);
  if ("error" in coverage) {
    results.push({ target: subsystem, status: "FAIL", message: coverage.error });
    continue;
  }
  const line = aggregateByPrefix(coverage.rows, subsystem, "lines");
  const functions = aggregateByPrefix(coverage.rows, subsystem, "functions");
  if (line === null || functions === null) {
    results.push({
      target: subsystem,
      status: "FAIL",
      message: "no coverage rows matched the subsystem path; did the test target shrink?",
    });
  } else {
    results.push({
      target: subsystem,
      status: line < floor.line_min || functions < floor.function_min ? "FAIL" : "PASS",
      message: `line=${line.toFixed(2)} (${line < floor.line_min ? "<" : ">="}${floor.line_min}) function_lower_bound=${functions.toFixed(2)} (${functions < floor.function_min ? "<" : ">="}${floor.function_min}; Bun FNF/FNH conservative union)`,
    });
  }
}

const sourceFiles = ["apps/cockpit/src", "apps/engine/src", "apps/sk/src", "packages"].flatMap(
  (root) => listFiles(join(REPO, root), isSource).map((abs) => relative(REPO, abs)),
);
const canonicalEntries = assertCompletePureTargetInventory(sourceFiles);
if (!waveContext) {
  const readText = (path: string) => readFileSync(join(REPO, path), "utf8");
  const analysis = createClosureAnalysis({
    files: mutationClosureFiles(REPO),
    readText,
    tsconfig: readText("tsconfig.json"),
    cockpitTsconfig: readText("apps/cockpit/tsconfig.json"),
  });
  for (const entry of canonicalEntries)
    canonicalTestsByTarget.set(
      entry.path,
      directTestPaths(analysis, entry.path).filter((test) => !testUsesModuleMock(test)),
    );
}
const typeOnlyTargets = new Set(
  canonicalEntries.filter((entry) => entry.runtime_kind === "type_only").map((entry) => entry.path),
);
const fileFloors = resolveFileFloors(floors, sourceFiles);
for (const target of typeOnlyTargets) fileFloors.delete(target);
for (const file of PURE_MUTATION_TARGETS) {
  if (typeOnlyTargets.has(file)) continue;
  fileFloors.set(file, {
    ...fileFloors.get(file),
    line_min: 100,
    function_min: 100,
    rationale: "pure_mutation_target",
  });
}
const manifestTargets = waveContext ? [...waveContext.tests.keys()].sort() : [];
if (waveContext) {
  const shard = waveContext.manifest.shards.find((entry) => entry.id === waveContext?.shardId);
  if (!shard) throw new Error(`wave shard disappeared: ${waveContext.shardId}`);
  const runtimeManifestTargets = manifestTargets.filter(
    (target) => !waveContext?.typeOnlyTargets.has(target),
  );
  const execution = planCoverageShardExecution({
    targets: runtimeManifestTargets,
    tests: shard.tests,
    usesModuleMock: testUsesModuleMock,
  });
  if (execution.errors.length > 0) {
    for (const message of execution.errors) {
      const target = message.slice(message.lastIndexOf(": ") + 2);
      results.push({
        target,
        status: "FAIL",
        message: "no unmocked direct test is available for pure coverage proof",
      });
    }
  } else {
    for (const { target: file, tests } of execution.coverageGroups) {
      const floor = fileFloors.get(file);
      if (!floor) {
        results.push({ target: file, status: "FAIL", message: "file has no coverage floor" });
        continue;
      }
      const coverage = await runCoverage(tests, "per_target", [file]);
      if ("error" in coverage)
        results.push({ target: file, status: "FAIL", message: coverage.error });
      else results.push({ target: file, ...judgeFile(file, floor, coverage.rows) });
    }
  }
  for (const file of manifestTargets)
    if (waveContext.typeOnlyTargets.has(file))
      results.push({
        target: file,
        status: "SKIP",
        message: "type_only_ast (line/function runtime coverage not applicable)",
      });
  const behaviorReceipt = verifiedBehaviorReceipt(execution.behaviorOnlyTests);
  const behaviorError =
    behaviorReceipt === undefined
      ? await runClosureBehaviorTests(execution.behaviorOnlyTests)
      : behaviorReceipt || undefined;
  if (behaviorError)
    results.push({
      target: "closure",
      status: "FAIL",
      message: `isolated closure test failed: ${behaviorError}`,
    });
}
for (const [file, floor] of [...fileFloors.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  if (waveContext) continue;
  if (!wanted(file)) continue;
  if (!existsSync(join(REPO, file))) {
    results.push({
      target: file,
      status: "FAIL",
      message: "file listed in `files` does not exist",
    });
    continue;
  }
  const tests = testsFor(file, floor);
  if (tests.length === 0) {
    results.push({
      target: file,
      status: "FAIL",
      message: `no test file found (looked for ${testCandidates(file).join(", ")}; or set \`tests\`)`,
    });
    continue;
  }
  const coverage = await runCoverage(tests, "per_target", [file]);
  if ("error" in coverage) {
    results.push({ target: file, status: "FAIL", message: coverage.error });
    continue;
  }
  results.push({ target: file, ...judgeFile(file, floor, coverage.rows) });
}
for (const file of [...typeOnlyTargets].sort())
  if (!waveContext && wanted(file))
    results.push({
      target: file,
      status: "SKIP",
      message: "type_only_ast (line/function runtime coverage not applicable)",
    });

if (results.length === 0) {
  results.push({ target: "selection", status: "FAIL", message: "no coverage targets matched" });
}

if (!coverageLease) throw new Error("coverage raw run lease was not initialized");
try {
  if (results.every((result) => result.status !== "FAIL")) {
    const persistenceError = await persistCoverageArtifact();
    if (persistenceError) {
      retainCoverageRawRun(coverageLease, "failed", persistenceError);
      results.push({ target: "provenance", status: "FAIL", message: persistenceError });
    } else if (process.env.SUBKIT_COVERAGE_KEEP_RAW === "1") {
      retainCoverageRawRun(coverageLease, "debug", "SUBKIT_COVERAGE_KEEP_RAW=1");
    } else {
      removeCoverageRawRunAfterReceipt(coverageLease);
    }
  } else {
    retainCoverageRawRun(coverageLease, "failed", "coverage floor verification failed");
  }
} catch (error) {
  const message = `coverage finalization failed: ${error instanceof Error ? error.message : String(error)}`;
  try {
    retainCoverageRawRun(coverageLease, "failed", message);
  } catch {}
  results.push({ target: "provenance", status: "FAIL", message });
} finally {
  disposeCoverageSignalRetention?.();
}

let pass = 0;
let fail = 0;
let skip = 0;
for (const r of results) {
  console.log(`${r.status.padEnd(4)} ${r.target.padEnd(36)} ${r.message}`);
  if (r.status === "PASS") pass++;
  else if (r.status === "FAIL") fail++;
  else skip++;
}
console.log(`\n${pass} pass, ${fail} fail, ${skip} skip`);

process.exit(fail === 0 ? 0 : 1);
