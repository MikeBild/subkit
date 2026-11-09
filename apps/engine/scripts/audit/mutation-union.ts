import { createHash } from "node:crypto";
import type { MutationEquivalentManifest } from "./mutation-floor.ts";
import { buildMutationShardConfig } from "./mutation-shard-config.ts";
import { inspectMutationShardScore } from "./mutation-shard-score.ts";
import type { MutationWaveManifest } from "./mutation-wave.ts";

export interface MutationShardReceipt {
  version: 1;
  wave_id: string;
  run_id: string;
  shard_id: string;
  manifest_sha256: string;
  config_sha256: string;
  base_config_sha256: string;
  report_sha256: string;
  source_sha256: string;
  test_sha256: string;
  target_digest_sha256: string;
  canonical_target_sha256: string;
  lock_sha256: string;
  equivalence_manifest_sha256: string;
  dynamic_import_ledger_sha256: string;
  parent_validation_ticket_path?: string;
  parent_validation_ticket_sha256?: string;
  started_at: string;
  finished_at: string;
  exit_code: number;
  targets: readonly string[];
  runtime_targets?: readonly string[];
  type_only_targets?: readonly string[];
  not_applicable?: "type_only_ast";
  workers: number;
}

export interface MutationShardUnionInput {
  wave: MutationWaveManifest;
  runId: string;
  manifestPath: string;
  baseConfig: unknown;
  canonicalScope: readonly string[];
  runtimeScope?: readonly string[];
  sourceSha256: string;
  testSha256: string;
  workersByShard: Readonly<Record<string, number>>;
  shards: readonly {
    id: string;
    receiptText: string;
    configText: string;
    reportText: string;
    exitCode: number;
  }[];
  manifestSha256: string;
  equivalenceManifest: MutationEquivalentManifest;
  repo: string;
  sourceSha256ForFile: (file: string) => string | null;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const SHA256 = /^[a-f0-9]{64}$/;
const canonicalPath = (value: string) =>
  value.length > 0 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.split("/").some((part) => part === "" || part === "." || part === "..");
const parse = (text: string, label: string, errors: string[]): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object") throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    errors.push(`${label} is invalid JSON`);
    return null;
  }
};
const security = (config: Record<string, unknown>, key: string): unknown => {
  if (key === "ignoreStatic") return config.ignoreStatic ?? false;
  if (key === "excludedMutations")
    return (
      config.excludedMutations ??
      (config.mutator as Record<string, unknown> | undefined)?.excludedMutations ??
      []
    );
  if (key === "mutator") return undefined;
  return config[key];
};

export function validateMutationShardUnion(input: MutationShardUnionInput): string[] {
  const errors: string[] = [];
  let ticketPath: string | undefined;
  let ticketSha256: string | undefined;
  const expected = new Set(input.canonicalScope);
  const runtimeScope = new Set(input.runtimeScope ?? input.canonicalScope);
  for (const equivalent of input.equivalenceManifest.equivalents)
    if (!expected.has(equivalent.file))
      errors.push(`equivalence entry has foreign target: ${equivalent.file}`);
  const waveTargets = new Map<string, string>();
  for (const shard of input.wave.shards)
    for (const target of shard.targets) {
      if (waveTargets.has(target)) errors.push(`wave target has multiple owners: ${target}`);
      waveTargets.set(target, shard.id);
    }
  for (const target of expected)
    if (!waveTargets.has(target)) errors.push(`canonical target is missing from wave: ${target}`);
  for (const target of waveTargets)
    if (!expected.has(target[0])) errors.push(`wave has extra target: ${target[0]}`);
  const actual = new Map(input.shards.map((shard) => [shard.id, shard]));
  if (actual.size !== input.shards.length) errors.push("duplicate shard result");
  for (const shard of input.wave.shards) {
    const runtimeTargets = shard.targets.filter((target) => runtimeScope.has(target));
    const result = actual.get(shard.id);
    if (!result) {
      errors.push(`missing shard result: ${shard.id}`);
      continue;
    }
    const receipt = parse(result.receiptText, `shard ${shard.id} receipt`, errors);
    if (!receipt) continue;
    const receiptTicketPath = receipt.parent_validation_ticket_path;
    const receiptTicketSha256 = receipt.parent_validation_ticket_sha256;
    if (receiptTicketPath === undefined && receiptTicketSha256 === undefined) {
      if (ticketPath !== undefined)
        errors.push(`shard ${shard.id} receipt omits parent validation ticket binding`);
    } else if (
      typeof receiptTicketPath !== "string" ||
      !canonicalPath(receiptTicketPath) ||
      typeof receiptTicketSha256 !== "string" ||
      !SHA256.test(receiptTicketSha256)
    ) {
      errors.push(`shard ${shard.id} receipt parent validation ticket binding is invalid`);
    } else if (ticketPath === undefined) {
      ticketPath = receiptTicketPath;
      ticketSha256 = receiptTicketSha256;
    } else if (ticketPath !== receiptTicketPath || ticketSha256 !== receiptTicketSha256) {
      errors.push(`shard ${shard.id} receipt parent validation ticket binding differs`);
    }
    for (const [key, value] of [
      ["version", 1],
      ["wave_id", input.wave.wave_id],
      ["run_id", input.runId],
      ["shard_id", shard.id],
      ["manifest_sha256", input.manifestSha256],
      ["source_sha256", input.sourceSha256],
      ["test_sha256", input.testSha256],
      ["target_digest_sha256", input.wave.target_digest_sha256],
      ["canonical_target_sha256", input.wave.target_digest_sha256],
      ["base_config_sha256", input.wave.config_sha256],
      ["lock_sha256", input.wave.lock_sha256],
      ["equivalence_manifest_sha256", input.wave.equivalence_manifest_sha256],
      ["dynamic_import_ledger_sha256", input.wave.dynamic_import_ledger_sha256],
    ] as const)
      if (receipt[key] !== value) errors.push(`shard ${shard.id} receipt ${key} mismatch`);
    if (JSON.stringify(receipt.targets) !== JSON.stringify(shard.targets))
      errors.push(`shard ${shard.id} receipt targets mismatch`);
    if (
      input.runtimeScope !== undefined &&
      JSON.stringify(receipt.runtime_targets) !== JSON.stringify(runtimeTargets)
    )
      errors.push(`shard ${shard.id} receipt runtime targets mismatch`);
    if (
      input.runtimeScope !== undefined &&
      JSON.stringify(receipt.type_only_targets) !==
        JSON.stringify(shard.targets.filter((target) => !runtimeScope.has(target)))
    )
      errors.push(`shard ${shard.id} receipt type-only targets mismatch`);
    if (receipt.workers !== (input.workersByShard[shard.id] ?? 0))
      errors.push(`shard ${shard.id} receipt workers mismatch`);
    if (
      typeof receipt.started_at !== "string" ||
      typeof receipt.finished_at !== "string" ||
      Number.isNaN(Date.parse(receipt.started_at)) ||
      Number.isNaN(Date.parse(receipt.finished_at)) ||
      Date.parse(receipt.finished_at) < Date.parse(receipt.started_at)
    )
      errors.push(`shard ${shard.id} receipt terminal metadata invalid`);
    if (runtimeTargets.length === 0) {
      if (
        receipt.not_applicable !== "type_only_ast" ||
        result.configText !== "" ||
        result.reportText !== ""
      )
        errors.push(`shard ${shard.id} type-only audit is not explicit`);
      if (receipt.exit_code !== result.exitCode || result.exitCode !== 0)
        errors.push(`shard ${shard.id} type-only audit is not terminal`);
      continue;
    }
    if (receipt.not_applicable !== undefined)
      errors.push(`shard ${shard.id} runtime mutation cannot be not applicable`);
    const config = parse(result.configText, `shard ${shard.id} config`, errors);
    const report = parse(result.reportText, `shard ${shard.id} report`, errors);
    if (!config || !report) continue;
    if (receipt.config_sha256 !== hash(result.configText))
      errors.push(`shard ${shard.id} config hash mismatch`);
    if (receipt.report_sha256 !== hash(result.reportText))
      errors.push(`shard ${shard.id} report hash mismatch`);
    let generated: Record<string, unknown>;
    try {
      generated = buildMutationShardConfig({
        base: input.baseConfig,
        waveId: input.wave.wave_id,
        runId: input.runId,
        manifestPath: input.manifestPath,
        ...(input.wave.quality_policy_sha256 ? { repo: input.repo } : {}),
        shard: { ...shard, targets: runtimeTargets },
        workers: input.workersByShard[shard.id] ?? 0,
      });
    } catch (error) {
      errors.push(`shard ${shard.id} cannot generate expected config: ${String(error)}`);
      continue;
    }
    for (const key of [
      "testRunner",
      "mutate",
      "incremental",
      "coverageAnalysis",
      "thresholds",
      "reporters",
      "jsonReporter",
      "concurrency",
      "commandRunner",
      "tempDirName",
      "cleanTempDir",
      "ignoreStatic",
      "excludedMutations",
    ])
      if (JSON.stringify(security(config, key)) !== JSON.stringify(security(generated, key)))
        errors.push(`shard ${shard.id} config ${key} mismatch`);
    const reportConfig = report.config as Record<string, unknown> | undefined;
    if (
      (Array.isArray(report.errors) && report.errors.length > 0) ||
      (typeof report.error === "string" && report.error.length > 0)
    )
      errors.push(`shard ${shard.id} report has nonterminal errors`);
    if (!reportConfig) errors.push(`shard ${shard.id} report has no config`);
    else
      for (const key of [
        "testRunner",
        "mutate",
        "incremental",
        "coverageAnalysis",
        "thresholds",
        "commandRunner",
        "ignoreStatic",
        "excludedMutations",
        "tempDirName",
      ])
        if (
          JSON.stringify(security(reportConfig, key)) !== JSON.stringify(security(generated, key))
        )
          errors.push(`shard ${shard.id} report config ${key} mismatch`);
    const files = report.files as Record<string, unknown> | undefined;
    if (!files) {
      errors.push(`shard ${shard.id} report has no files`);
      continue;
    }
    const seen = new Set<string>();
    for (const [file, item] of Object.entries(files)) {
      if (!runtimeTargets.includes(file))
        errors.push(`shard ${shard.id} report has foreign target: ${file}`);
      seen.add(file);
      if (!item || typeof item !== "object") {
        errors.push(`shard ${shard.id} report has malformed file: ${file}`);
        continue;
      }
      const reportItem = item as { source?: unknown; mutants?: unknown };
      if (typeof reportItem.source !== "string")
        errors.push(`shard ${shard.id} report target has no source: ${file}`);
      else {
        const expectedSource = input.sourceSha256ForFile(file);
        if (expectedSource === null)
          errors.push(`shard ${shard.id} target source is unavailable: ${file}`);
        else if (hash(reportItem.source) !== expectedSource)
          errors.push(`shard ${shard.id} report target source mismatch: ${file}`);
      }
      const mutants = reportItem.mutants;
      if (!Array.isArray(mutants) || mutants.length === 0)
        errors.push(`shard ${shard.id} target has zero mutants: ${file}`);
      else
        for (const mutant of mutants as Array<{ status?: unknown }>)
          if (
            mutant?.status !== "Killed" &&
            mutant?.status !== "Timeout" &&
            mutant?.status !== "Ignored" &&
            mutant?.status !== "Survived"
          )
            errors.push(`shard ${shard.id} has undetected mutant: ${file}`);
    }
    for (const target of runtimeTargets)
      if (!seen.has(target)) errors.push(`shard ${shard.id} report misses target: ${target}`);
    if (receipt.exit_code !== result.exitCode)
      errors.push(`shard ${shard.id} receipt terminal metadata invalid`);
    const scoring = inspectMutationShardScore({
      report,
      exitCode: result.exitCode,
      manifest: {
        ...input.equivalenceManifest,
        equivalents: input.equivalenceManifest.equivalents.filter((entry) =>
          runtimeTargets.includes(entry.file),
        ),
      },
      repo: input.repo,
      expectedScope: runtimeTargets,
      sourceSha256ForFile: input.sourceSha256ForFile,
    });
    errors.push(...scoring.errors.map((error) => `shard ${shard.id}: ${error}`));
  }
  for (const id of actual.keys())
    if (!input.wave.shards.some((shard) => shard.id === id))
      errors.push(`extra shard result: ${id}`);
  if (ticketPath !== undefined)
    for (const shard of input.shards) {
      const receipt = parse(shard.receiptText, `shard ${shard.id} receipt`, errors);
      if (
        receipt &&
        (receipt.parent_validation_ticket_path !== ticketPath ||
          receipt.parent_validation_ticket_sha256 !== ticketSha256)
      )
        errors.push(`shard ${shard.id} receipt parent validation ticket binding is incomplete`);
    }
  return errors;
}
