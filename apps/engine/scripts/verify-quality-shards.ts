import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { readPublishedCoverage } from "./audit/coverage-artifacts.ts";
import {
  type CoverageShardNative,
  type CoverageShardReceipt,
  validateCoverageShardUnion,
} from "./audit/coverage-union.ts";
import { planMutationBatches } from "./audit/mutation-scheduler.ts";
import {
  inspectMutationShardScore,
  summarizeMutationScores,
} from "./audit/mutation-shard-score.ts";
import { validateMutationShardUnion } from "./audit/mutation-union.ts";
import { runtimePureTargetPaths } from "./audit/pure-targets.ts";
import { validateExternalRuntimeAcceptance } from "./run-external-runtime-acceptance.ts";
import { loadMutationWave } from "./run-mutation-shards.ts";

const REPO = resolve(import.meta.dir, "../../..");
const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function regular(path: string): string {
  let current = resolve(path);
  while (true) {
    if (lstatSync(current).isSymbolicLink())
      throw new Error(`quality evidence must not traverse a symbolic link: ${current}`);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`quality evidence must be a regular file: ${path}`);
  return readFileSync(path, "utf8");
}

function under(repo: string, path: string): string {
  const value = resolve(path);
  if (!value.startsWith(`${resolve(repo)}${sep}`))
    throw new Error(`quality evidence escapes repository: ${path}`);
  return value;
}

function object(text: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${label} must be an object`);
  return parsed as Record<string, unknown>;
}

function validateUnionReceipts(
  union: Record<string, unknown>,
  root: string,
  ids: readonly string[],
  targetCount: number,
): void {
  if (union.version !== 1 || union.target_count !== targetCount || !Array.isArray(union.shards))
    throw new Error("invalid union inventory");
  const seen = new Set<string>();
  for (const value of union.shards) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.id !== "string" ||
      !ids.includes(value.id) ||
      seen.has(value.id)
    )
      throw new Error("invalid union shard ownership");
    seen.add(value.id);
    if (value.receipt_sha256 !== hash(regular(join(root, value.id, "receipt.json"))))
      throw new Error("union receipt hash mismatch");
  }
  if (seen.size !== ids.length) throw new Error("union is missing shard receipts");
}

export async function verifyQualityShards(options: {
  repo: string;
  mutationUnionPath: string;
  coverageUnionPath: string;
  externalRuntimeAcceptancePath?: string;
  requireVersionedPolicy?: boolean;
}): Promise<string> {
  const mutationPath = under(options.repo, options.mutationUnionPath);
  const coveragePath = under(options.repo, options.coverageUnionPath);
  const mutationText = regular(mutationPath);
  const coverageText = regular(coveragePath);
  const mutation = object(mutationText, "mutation union");
  const coverage = object(coverageText, "coverage union");
  for (const key of ["wave_id", "manifest_sha256"] as const)
    if (mutation[key] !== coverage[key]) throw new Error(`paired union ${key} mismatch`);
  const mutationRoot = dirname(mutationPath);
  const coverageRoot = dirname(coveragePath);
  const manifestPath = join(mutationRoot, "wave.json");
  const coverageManifest = regular(join(coverageRoot, "wave.json"));
  const manifestText = regular(manifestPath);
  if (manifestText !== coverageManifest)
    throw new Error("paired unions use different frozen wave bytes");
  if (hash(manifestText) !== mutation.manifest_sha256) throw new Error("frozen wave hash mismatch");
  const prepared = loadMutationWave(options.repo, manifestPath);
  const { wave, entries, baseConfig, equivalents } = prepared;
  const runtimeScope = runtimePureTargetPaths(entries);
  if (options.requireVersionedPolicy && !wave.quality_policy_sha256)
    throw new Error("Release quality proof requires a versioned policy-bound wave");
  if ((wave.external_runtime_tests?.length ?? 0) > 0) {
    if (!options.externalRuntimeAcceptancePath)
      throw new Error("Release quality proof requires external runtime acceptance evidence");
    const receiptPath = under(
      options.repo,
      join(options.repo, options.externalRuntimeAcceptancePath),
    );
    const errors = validateExternalRuntimeAcceptance(
      options.repo,
      wave,
      manifestText,
      object(regular(receiptPath), "external runtime acceptance"),
    );
    if (errors.length > 0)
      throw new Error(`external runtime acceptance rejected: ${errors.join("; ")}`);
  }
  const shardIds = wave.shards.map((shard) => shard.id);
  validateUnionReceipts(mutation, mutationRoot, shardIds, entries.length);
  validateUnionReceipts(coverage, coverageRoot, shardIds, entries.length);
  if (mutation.wave_id !== wave.wave_id || coverage.wave_id !== wave.wave_id)
    throw new Error("union wave id mismatch");
  const mutationRunId = String(mutation.run_id ?? "");
  const coverageRunId = String(coverage.run_id ?? "");
  if (!mutationRunId || !coverageRunId) throw new Error("union run id missing");
  const mutationShards = wave.shards.map((shard) => {
    const root = join(mutationRoot, shard.id);
    const receiptText = regular(join(root, "receipt.json"));
    const receipt = object(receiptText, "mutation receipt");
    if (typeof receipt.exit_code !== "number" || !Number.isInteger(receipt.exit_code))
      throw new Error("mutation receipt exit code is invalid");
    const hasRuntime = shard.targets.some((target) => runtimeScope.includes(target));
    return {
      id: shard.id,
      receiptText,
      configText: hasRuntime ? regular(join(root, "stryker.json")) : "",
      reportText: hasRuntime ? regular(join(root, "mutation.json")) : "",
      exitCode: receipt.exit_code,
    };
  });
  const workersByShard = Object.fromEntries(
    planMutationBatches(wave.shards, wave.worker_budget)
      .flat()
      .map((item) => [item.id, item.workers]),
  );
  const mutationErrors = validateMutationShardUnion({
    wave,
    runId: mutationRunId,
    manifestPath,
    baseConfig,
    canonicalScope: entries.map((entry) => entry.path),
    runtimeScope,
    sourceSha256: wave.source_freeze_sha256,
    testSha256: wave.test_freeze_sha256,
    workersByShard,
    shards: mutationShards,
    manifestSha256: hash(manifestText),
    equivalenceManifest: equivalents,
    repo: options.repo,
    sourceSha256ForFile: (file) =>
      existsSync(join(options.repo, file)) ? hash(readFileSync(join(options.repo, file))) : null,
  });
  if (mutationErrors.length > 0)
    throw new Error(`mutation union rejected: ${mutationErrors.join("; ")}`);
  const scores = mutationShards.flatMap((result) => {
    if (result.reportText === "") return [];
    const targets = wave.shards
      .find((shard) => shard.id === result.id)!
      .targets.filter((target) => runtimeScope.includes(target));
    return inspectMutationShardScore({
      report: JSON.parse(result.reportText),
      exitCode: result.exitCode,
      manifest: {
        ...equivalents,
        equivalents: equivalents.equivalents.filter((entry) => targets.includes(entry.file)),
      },
      repo: options.repo,
      expectedScope: targets,
      sourceSha256ForFile: (file) => hash(readFileSync(join(options.repo, file))),
    }).scores;
  });
  const mutationSummary = summarizeMutationScores(scores);
  for (const [key, expected] of Object.entries({
    mutation_score: mutationSummary.adjusted_score,
    raw_mutation_score: mutationSummary.raw_score,
    adjusted_mutation_score: mutationSummary.adjusted_score,
  }))
    if (mutation[key] !== undefined && mutation[key] !== expected)
      throw new Error(`mutation union ${key} does not match raw reports`);
  if (
    mutation.score_summary !== undefined &&
    JSON.stringify(mutation.score_summary) !== JSON.stringify(mutationSummary)
  )
    throw new Error("mutation union score summary does not match raw reports");
  const coverageReceipts: CoverageShardReceipt[] = [];
  const native: CoverageShardNative[] = [];
  for (const shard of wave.shards) {
    const root = join(coverageRoot, shard.id);
    const coordinatorReceipt = object(
      regular(join(root, "receipt.json")),
      "coverage receipt",
    ) as unknown as CoverageShardReceipt;
    coverageReceipts.push(coordinatorReceipt);
    if (!shard.targets.some((target) => runtimeScope.includes(target))) continue;
    const evidenceRoot = join(root, "coverage");
    const published = readPublishedCoverage(evidenceRoot);
    const nativeReceipt = object(regular(published.receiptPath), "native coverage receipt");
    const refs = nativeReceipt.direct_target_evidence;
    if (!Array.isArray(refs))
      throw new Error(`native coverage receipt has no direct evidence: ${shard.id}`);
    for (const ref of refs) {
      if (!ref || typeof ref !== "object" || typeof (ref as { path?: unknown }).path !== "string")
        throw new Error(`native coverage receipt has invalid direct evidence: ${shard.id}`);
      const proofPath = join(published.runDir, (ref as { path: string }).path);
      if (!published.targetProofPaths.includes(proofPath))
        throw new Error(`native coverage receipt proof was not published: ${shard.id}`);
      regular(proofPath);
      const target = (ref as { target?: unknown }).target;
      const embedded = coordinatorReceipt.direct_target_evidence.find(
        (proof) => proof.target === target,
      );
      if (!embedded || readFileSync(proofPath, "utf8") !== embedded.lcov)
        throw new Error(`coverage coordinator proof contents mismatch: ${shard.id}`);
    }
    native.push({
      id: shard.id,
      evidence_root: evidenceRoot,
      latest: {
        path: published.latestPath,
        sha256: hash(published.latestContents),
        contents: published.latestContents,
      },
      receiptText: regular(published.receiptPath),
      provenanceText: regular(published.provenancePath),
      lcovText: regular(published.lcovPath),
    });
  }
  const coverageErrors = validateCoverageShardUnion({
    wave,
    runId: coverageRunId,
    manifestSha256: hash(manifestText),
    sourceSha256: wave.source_freeze_sha256,
    canonicalScope: entries.map((entry) => entry.path),
    runtimeScope,
    shards: coverageReceipts,
    native,
    repo: options.repo,
  });
  if (coverageErrors.length > 0)
    throw new Error(`coverage union rejected: ${coverageErrors.join("; ")}`);
  const outputRoot = join(options.repo, "reports/quality/runs", wave.wave_id);
  mkdirSync(outputRoot, { recursive: true });
  const receipt = {
    version: 1,
    wave_id: wave.wave_id,
    manifest_sha256: hash(manifestText),
    source_sha256: wave.source_freeze_sha256,
    test_sha256: wave.test_freeze_sha256,
    target_digest_sha256: wave.target_digest_sha256,
    ...(wave.quality_policy_sha256 ? { quality_policy_sha256: wave.quality_policy_sha256 } : {}),
    mutation: {
      union_path: relative(options.repo, mutationPath),
      union_sha256: hash(mutationText),
      run_id: mutationRunId,
      score: mutationSummary.adjusted_score,
      raw_score: mutationSummary.raw_score,
      adjusted_score: mutationSummary.adjusted_score,
      score_summary: mutationSummary,
    },
    coverage: {
      union_path: relative(options.repo, coveragePath),
      union_sha256: hash(coverageText),
      run_id: coverageRunId,
      line: 100,
      function: 100,
    },
    ...(options.externalRuntimeAcceptancePath
      ? {
          external_runtime_acceptance: {
            path: options.externalRuntimeAcceptancePath,
            sha256: hash(
              regular(
                under(options.repo, join(options.repo, options.externalRuntimeAcceptancePath)),
              ),
            ),
          },
        }
      : {}),
    accepted_at: new Date().toISOString(),
  };
  const output = join(outputRoot, `acceptance-${randomUUID()}.json`);
  const temporary = `${output}.tmp`;
  writeFileSync(temporary, json(receipt), { flag: "wx" });
  renameSync(temporary, output);
  return output;
}

if (import.meta.main) {
  const rawArgs = process.argv.slice(2);
  const requireVersionedPolicy = rawArgs.includes("--release");
  const args = rawArgs.filter((arg) => arg !== "--release");
  const mutationIndex = args.indexOf("--mutation");
  const coverageIndex = args.indexOf("--coverage");
  const externalIndex = args.indexOf("--external-runtime");
  if (
    args.length !== (externalIndex < 0 ? 4 : 6) ||
    mutationIndex < 0 ||
    coverageIndex < 0 ||
    (externalIndex >= 0 && !args[externalIndex + 1]) ||
    !args[mutationIndex + 1] ||
    !args[coverageIndex + 1]
  )
    throw new Error(
      "usage: verify-quality-shards.ts --mutation <union.json> --coverage <union.json> [--external-runtime <acceptance.json>] [--release]",
    );
  console.log(
    await verifyQualityShards({
      repo: REPO,
      requireVersionedPolicy,
      mutationUnionPath: resolve(REPO, args[mutationIndex + 1]!),
      coverageUnionPath: resolve(REPO, args[coverageIndex + 1]!),
      ...(externalIndex >= 0 ? { externalRuntimeAcceptancePath: args[externalIndex + 1]! } : {}),
    }),
  );
}
