import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { exportShardQualityEvidence } from "../../../scripts/export-shard-quality-evidence.ts";
import {
  packQualityArtifacts,
  restoreQualityArtifacts,
} from "./audit/distributed-quality-artifacts.ts";
import { deriveDistributedBaselineBudget } from "./audit/distributed-quality-budget.ts";
import {
  assertCompleteDistributedShardSet,
  assertDistributedRuntimeSnapshotArtifacts,
  canonicalDistributedQualityTicket,
  distributedQualityTicketSha256,
  distributedRuntimeSnapshot,
  parseDistributedQualityTicket,
} from "./audit/distributed-quality-ticket.ts";
import { rehydrateMutationRuntimeSnapshot } from "./audit/mutation-runtime-snapshot.ts";
import { runtimePureTargetPaths } from "./audit/pure-targets.ts";
import { runHermeticQualityAction } from "./audit/quality-hermetic-launcher.ts";
import { createDistributedQualityTicket } from "./prepare-distributed-quality-ticket.ts";
import {
  collectCoverageShardUnion,
  coverageBehaviorProofDescriptor,
  coverageBehaviorProofPath,
  executeCoverageBehaviorGroups,
  executeCoverageWave,
} from "./run-coverage-shards.ts";
import { executeExternalRuntimeAcceptance } from "./run-external-runtime-acceptance.ts";
import {
  executeMutationShard,
  loadMutationWave,
  prepareMutationShardExecution,
  publishMutationShardUnion,
} from "./run-mutation-shards.ts";
import { validateDistributedQualityExecutor } from "./validate-distributed-quality-executor.ts";

const repo = resolve(import.meta.dir, "../../..");
const scriptPath = import.meta.path;
const coordinator = join(repo, "reports/distributed-quality/coordinator");
const packageRoot = join(coordinator, "package");
const input = join(repo, "reports/quality-inputs/distributed");
const manifestPath = () => join(input, "wave.json");
const ticketPath = () => join(input, "ticket.json");
const gitHead = () =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const trusted = () => ({
  commit: process.env.SUBKIT_QUALITY_COMMIT ?? gitHead(),
  githubRunId: process.env.GITHUB_RUN_ID ?? "0",
});
const run = (script: string, args: string[]) =>
  execFileSync("bun", ["run", `apps/engine/scripts/${script}`, ...args], {
    cwd: repo,
    stdio: "inherit",
    env: process.env,
  });
const out = (k: string, v: string) => {
  if (process.env.GITHUB_OUTPUT)
    writeFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`, { flag: "a" });
};

function allFiles(root: string, base = repo): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((x) => {
      const path = join(dir, x.name);
      if (x.isSymbolicLink()) throw new Error("Distributed package symlink is forbidden");
      if (x.isDirectory()) return walk(path);
      if (x.isFile()) return [relative(base, path)];
      throw new Error("Distributed package contains nonregular file");
    });
  return walk(root).sort();
}

export function distributedShardPackageFiles(options: {
  repo: string;
  waveId: string;
  coverageRunId: string;
  mutationRunId: string;
}): string[] {
  const mutationRoot = join(
    options.repo,
    "reports/mutation/runs",
    options.waveId,
    options.mutationRunId,
  );
  const ticket = relative(options.repo, join(mutationRoot, "mutation-validation-ticket.json"));
  const snapshots = `${relative(options.repo, join(mutationRoot, "runtime-snapshots"))}/`;
  return [
    join(options.repo, "reports/coverage/shards", options.waveId, options.coverageRunId),
    mutationRoot,
  ]
    .flatMap((root) => (existsSync(root) ? allFiles(root, options.repo) : []))
    .filter((path) => path !== ticket && !path.startsWith(snapshots));
}

export function portableRuntimeSnapshotFiles(options: {
  repo: string;
  snapshotPath: string;
  artifacts: readonly { path: string }[];
}): string[] {
  return [
    relative(options.repo, join(options.snapshotPath, "runtime-snapshot.json")),
    ...options.artifacts.map((artifact) =>
      relative(options.repo, join(options.snapshotPath, artifact.path)),
    ),
  ].sort();
}
function readTicket() {
  const text = readFileSync(ticketPath(), "utf8"),
    value = parseDistributedQualityTicket(JSON.parse(text));
  if (text !== canonicalDistributedQualityTicket(value))
    throw new Error("Distributed ticket serialization is noncanonical");
  return { value, sha256: distributedQualityTicketSha256(value) };
}
function restoreCoordinator() {
  const portable = readFileSync(join(packageRoot, "files", relative(repo, ticketPath())), "utf8");
  const candidate = parseDistributedQualityTicket(JSON.parse(portable));
  if (portable !== canonicalDistributedQualityTicket(candidate))
    throw new Error("Coordinator ticket serialization is noncanonical");
  const initial = { value: candidate, sha256: distributedQualityTicketSha256(candidate) },
    identity = trusted();
  restoreQualityArtifacts({
    repo,
    source: packageRoot,
    expectedIdentity: { ...identity, ticketSha256: initial.sha256 },
  });
  const restored = readTicket();
  if (
    restored.sha256 !== initial.sha256 ||
    restored.value.coordinator_commit_sha !== identity.commit ||
    restored.value.github_run_id !== identity.githubRunId
  )
    throw new Error("Coordinator package is foreign");
  const snapshot = distributedRuntimeSnapshot(restored.value);
  const rehydrated = rehydrateMutationRuntimeSnapshot({
    path: join(repo, snapshot.path),
    sha256: snapshot.sha256,
    expected: {
      wave_id: restored.value.wave_id,
      run_id: restored.value.mutation_run_id,
      source_freeze_sha256: restored.value.source_sha256,
      manifest_sha256: restored.value.manifest_sha256,
      artifact_digest_sha256: snapshot.artifact_digest_sha256,
    },
  });
  assertDistributedRuntimeSnapshotArtifacts(restored.value, rehydrated.artifacts);
  return restored;
}
export function selectDistributedCoverageBehaviorProof(options: {
  repo: string;
  manifestPath: string;
  waveId: string;
  coverageRunId: string;
  shardId: string;
}): string {
  const root = join(
    options.repo,
    "reports/coverage/shards",
    options.waveId,
    options.coverageRunId,
    "behavior",
  );
  const prepared = loadMutationWave(options.repo, options.manifestPath);
  const runtimeScope = runtimePureTargetPaths(prepared.entries);
  const wanted = prepared.wave.shards.find((s) => s.id === options.shardId);
  if (!wanted) throw new Error("Unknown shard behavior proof");
  const shard = {
    ...wanted,
    targets: wanted.targets.filter((target) => runtimeScope.includes(target)),
  };
  const usesModuleMock = (test: string) =>
    readFileSync(join(options.repo, test), "utf8").includes("mock.module(");
  const descriptor = coverageBehaviorProofDescriptor({ shard, usesModuleMock });
  const path = coverageBehaviorProofPath({
    artifactRoot: root,
    shard,
    usesModuleMock,
  });
  if (!existsSync(path)) throw new Error("Shard behavior proof absent or misrouted");
  const proof = JSON.parse(readFileSync(path, "utf8")) as {
    wave_id?: unknown;
    tests?: unknown;
  };
  if (
    proof.wave_id !== options.waveId ||
    !Array.isArray(proof.tests) ||
    JSON.stringify(proof.tests) !== JSON.stringify(descriptor.tests)
  )
    throw new Error("Shard behavior proof absent or misrouted");
  return path;
}
export function measureDistributedBehaviorDurations(input: {
  repo: string;
  proofs: ReadonlyMap<string, string>;
}): Map<string, Map<string, number>> {
  const measured = new Map<string, Map<string, number>>();
  for (const [shardId, proofPath] of input.proofs) {
    const shardMeasurements = new Map<string, number>();
    const proof = JSON.parse(readFileSync(proofPath, "utf8")) as {
      terminal: Array<{ test: string; manifest_path: string }>;
    };
    for (const item of proof.terminal) {
      const manifest = JSON.parse(readFileSync(join(input.repo, item.manifest_path), "utf8")) as {
        startedAt?: string;
        finishedAt?: string;
      };
      const ms = Date.parse(manifest.finishedAt ?? "") - Date.parse(manifest.startedAt ?? "");
      if (!Number.isSafeInteger(ms) || ms < 0)
        throw new Error("Behavior terminal manifest has invalid duration");
      if (shardMeasurements.has(item.test) && shardMeasurements.get(item.test) !== ms)
        throw new Error("Behavior test duration disagrees");
      shardMeasurements.set(item.test, ms);
    }
    measured.set(shardId, shardMeasurements);
  }
  return measured;
}
function assertClean(commit: string) {
  if (!/^[a-f0-9]{40}$/.test(commit) || gitHead() !== commit)
    throw new Error("Untrusted coordinator commit");
  execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: repo });
  if (
    execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: repo,
      encoding: "utf8",
    }).trim()
  )
    throw new Error("Coordinator requires clean checkout");
}

export async function prepareDistributedQuality() {
  const { commit, githubRunId } = trusted();
  assertClean(commit);
  mkdirSync(input, { recursive: true });
  mkdirSync(coordinator, { recursive: true });
  const ledger = join(input, "runtime-ledger.json"),
    candidate = join(input, "candidate.json"),
    waveId = `distributed-${randomUUID()}`;
  run("record-quality-runtime-witnesses.ts", ["--out", relative(repo, ledger)]);
  run("generate-quality-wave.ts", [
    "--dynamic-ledger",
    relative(repo, ledger),
    "--wave-id",
    waveId,
    "--out",
    relative(repo, candidate),
  ]);
  run("prepare-mutation-shards.ts", [
    "--manifest",
    relative(repo, candidate),
    "--dynamic-ledger",
    relative(repo, ledger),
    "--out",
    relative(repo, manifestPath()),
  ]);
  const frozenWave = loadMutationWave(repo, manifestPath()).wave;
  if (!frozenWave.quality_policy_sha256)
    throw new Error("Distributed quality requires a policy-bound wave");
  const coverageRunId = `run-coverage-${randomUUID()}`,
    mutationRunId = `run-mutation-${randomUUID()}`,
    behaviorRoot = join(repo, "reports/coverage/shards", waveId, coverageRunId, "behavior");
  const proofs = await executeCoverageBehaviorGroups({
    repo,
    manifestPath: manifestPath(),
    runId: coverageRunId,
    artifactRoot: behaviorRoot,
  });
  const prepared = prepareMutationShardExecution({
    repo,
    manifestPath: manifestPath(),
    runId: mutationRunId,
  });
  const durations = measureDistributedBehaviorDurations({ repo, proofs });
  const budgets = Object.fromEntries(
    prepared.wave.shards.map((s) => {
      const tests = s.tests
        .filter((test) => test.execution !== "external_runtime")
        .map((test) => test.path);
      return [
        s.id,
        deriveDistributedBaselineBudget(
          tests,
          tests.flatMap((test) =>
            durations.get(s.id)?.has(test)
              ? [{ test, durationMs: durations.get(s.id)!.get(test)! }]
              : [],
          ),
        ).baseline_budget_ms,
      ];
    }),
  );
  const value = createDistributedQualityTicket({
    manifestPath: manifestPath(),
    commit,
    githubRunId,
    baselineBudgets: budgets,
    campaignTimeoutMs: 6 * 60 * 60_000,
    coverageRunId,
    mutationRunId,
    ticketPath: relative(repo, ticketPath()),
    runtimeSnapshot: prepared.runtimeSnapshot,
  });
  writeFileSync(ticketPath(), canonicalDistributedQualityTicket(value), { flag: "wx" });
  const runtimeFiles =
    (
      JSON.parse(readFileSync(ledger, "utf8")) as {
        runtime_witnesses?: Array<{ execution_receipt_path?: string }>;
      }
    ).runtime_witnesses?.flatMap((w) => {
      if (
        !w.execution_receipt_path ||
        w.execution_receipt_path.startsWith("/") ||
        w.execution_receipt_path.includes("..")
      )
        throw new Error("Runtime witness path is unsafe");
      const receipt = join(repo, w.execution_receipt_path),
        dir = join(receipt, "..");
      return [
        relative(repo, receipt),
        relative(repo, join(dir, "manifest.json")),
        relative(repo, join(dir, "result.json")),
        relative(repo, join(dir, "runner.log")),
      ];
    }) ?? [];
  const runtimeSnapshotFiles = portableRuntimeSnapshotFiles({
    repo,
    snapshotPath: prepared.runtimeSnapshot.path,
    artifacts: prepared.runtimeSnapshot.snapshot.artifacts,
  });
  packQualityArtifacts({
    repo,
    destination: packageRoot,
    files: [
      ...new Set([
        ...allFiles(input),
        ...allFiles(behaviorRoot),
        ...runtimeSnapshotFiles,
        ...runtimeFiles,
      ]),
    ].sort(),
    identity: { commit, githubRunId, ticketSha256: distributedQualityTicketSha256(value) },
  });
  out("commit", commit);
  out("matrix", JSON.stringify({ shard: value.shards.map((s) => s.id) }));
}
export async function runDistributedCoverage() {
  const { value, sha256 } = restoreCoordinator(),
    { commit, githubRunId } = trusted(),
    shard = process.env.SUBKIT_QUALITY_SHARD;
  if (!shard) throw new Error("Missing trusted shard selector");
  validateDistributedQualityExecutor({
    ticketPath: ticketPath(),
    manifestPath: manifestPath(),
    shardId: shard,
    commit,
    githubRunId,
  });
  const coverageRoot = join(repo, "reports/coverage/shards", value.wave_id, value.coverage_run_id);
  await executeCoverageWave({
    repo,
    manifestPath: manifestPath(),
    timeoutMs: value.campaign_timeout_ms,
    runId: value.coverage_run_id,
    outputRoot: coverageRoot,
    shardIds: [shard],
    behaviorReceipts: new Map([
      [
        shard,
        selectDistributedCoverageBehaviorProof({
          repo,
          manifestPath: manifestPath(),
          waveId: value.wave_id,
          coverageRunId: value.coverage_run_id,
          shardId: shard,
        }),
      ],
    ]),
    distributed: { ticket: value, ticketSha256: sha256, commit, githubRunId },
  });
}
export async function runDistributedMutation() {
  const { value, sha256 } = restoreCoordinator(),
    { commit, githubRunId } = trusted(),
    shard = process.env.SUBKIT_QUALITY_SHARD;
  if (!shard) throw new Error("Missing trusted shard selector");
  validateDistributedQualityExecutor({
    ticketPath: ticketPath(),
    manifestPath: manifestPath(),
    shardId: shard,
    commit,
    githubRunId,
  });
  try {
    await executeMutationShard({
      repo,
      manifestPath: manifestPath(),
      shardId: shard,
      runId: value.mutation_run_id,
      campaignTimeoutMs: value.campaign_timeout_ms,
      distributed: { ticket: value, ticketSha256: sha256, commit, githubRunId },
    });
  } finally {
    const files = distributedShardPackageFiles({
      repo,
      waveId: value.wave_id,
      coverageRunId: value.coverage_run_id,
      mutationRunId: value.mutation_run_id,
    });
    packQualityArtifacts({
      repo,
      destination: join(repo, "reports/distributed-quality/shard/package"),
      files,
      identity: { commit, githubRunId, ticketSha256: sha256 },
    });
  }
}
export async function mergeDistributedQuality() {
  const { value, sha256 } = restoreCoordinator(),
    { commit, githubRunId } = trusted(),
    downloads = join(repo, "reports/distributed-quality/downloads");
  const packages = readdirSync(downloads, { withFileTypes: true })
    .filter((x) => x.isDirectory())
    .map((x) => join(downloads, x.name, "package"));
  if (packages.length !== value.shards.length)
    throw new Error("Missing or duplicate shard packages");
  for (const source of packages)
    restoreQualityArtifacts({
      repo,
      source,
      expectedIdentity: { commit, githubRunId, ticketSha256: sha256 },
    });
  const coverageRoot = join(repo, "reports/coverage/shards", value.wave_id, value.coverage_run_id),
    mutationRoot = join(repo, "reports/mutation/runs", value.wave_id, value.mutation_run_id);
  const coverageUnionPath = collectCoverageShardUnion({
    repo,
    manifestPath: manifestPath(),
    runId: value.coverage_run_id,
    shardRoots: new Map(value.shards.map((s) => [s.id, coverageRoot])),
    outputRoot: coverageRoot,
    distributed: { ticket: value, ticketSha256: sha256, commit, githubRunId },
  });
  const prepared = prepareMutationShardExecution({
    repo,
    manifestPath: manifestPath(),
    runId: value.mutation_run_id,
    root: mutationRoot,
  });
  const shards = value.shards.map((s) => {
    const d = join(mutationRoot, s.id),
      receiptText = readFileSync(join(d, "receipt.json"), "utf8");
    return {
      id: s.id,
      receiptText,
      configText: existsSync(join(d, "stryker.json"))
        ? readFileSync(join(d, "stryker.json"), "utf8")
        : "",
      reportText: existsSync(join(d, "mutation.json"))
        ? readFileSync(join(d, "mutation.json"), "utf8")
        : "",
      exitCode: JSON.parse(receiptText).exit_code,
    };
  });
  assertCompleteDistributedShardSet(
    value,
    shards.map((s) => JSON.parse(s.receiptText)),
  );
  const union = publishMutationShardUnion({
    prepared,
    shards,
    distributed: { ticket: value, ticketSha256: sha256, commit, githubRunId },
  });
  const external = await executeExternalRuntimeAcceptance({ repo, manifestPath: manifestPath() });
  await exportShardQualityEvidence({
    repo,
    coverageUnionPath,
    mutationUnionPath: union,
    ...(external ? { externalRuntimeAcceptancePath: external } : {}),
    destination: join(repo, "reports/quality-export/shards"),
  });
}
if (import.meta.main) {
  const action = process.argv[2];
  if (!action || !["prepare", "coverage", "mutation", "merge"].includes(action))
    throw new Error("usage: distributed-quality.ts <prepare|coverage|mutation|merge>");
  if (process.env.SUBKIT_QUALITY_HERMETIC_CI === "1")
    runHermeticQualityAction({
      executable: process.execPath,
      script: scriptPath,
      action,
      ambient: process.env,
    });
  if (action === "prepare") await prepareDistributedQuality();
  else if (action === "coverage") await runDistributedCoverage();
  else if (action === "mutation") await runDistributedMutation();
  else if (action === "merge") await mergeDistributedQuality();
}
