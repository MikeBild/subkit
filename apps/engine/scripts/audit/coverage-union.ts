import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { validateCoverageBehaviorProof } from "./coverage-behavior-proof.ts";
import { planCoverageShardExecution } from "./coverage-shard-plan.ts";
import { coverageRows, parseLcov } from "./lcov.ts";
import type { MutationWaveManifest } from "./mutation-wave.ts";

export interface CoverageShardReceipt {
  version: 1;
  wave_id: string;
  run_id: string;
  shard_id: string;
  manifest_sha256: string;
  source_sha256: string;
  base_config_sha256: string;
  coverage_config_sha256: string;
  test_sha256: string;
  target_digest_sha256: string;
  native_receipt_sha256?: string;
  native_provenance_sha256?: string;
  native_lcov_sha256?: string;
  targets: readonly string[];
  runtime_targets?: readonly string[];
  type_only_targets?: readonly string[];
  not_applicable?: "type_only_ast";
  direct_target_evidence: readonly { target: string; path: string; sha256: string; lcov: string }[];
}

export interface CoverageShardNative {
  id: string;
  evidence_root: string;
  latest: { path: string; sha256: string; contents: string };
  receiptText: string;
  provenanceText: string;
  lcovText: string;
}

export interface CoverageUnionInput {
  wave: MutationWaveManifest;
  runId: string;
  manifestSha256: string;
  sourceSha256: string;
  canonicalScope: readonly string[];
  runtimeScope?: readonly string[];
  shards: readonly CoverageShardReceipt[];
  native: readonly CoverageShardNative[];
  repo: string;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function parse(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

function references(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const rows: string[][] = [];
  for (const raw of value) {
    const item = record(raw);
    if (
      !item ||
      typeof item.target !== "string" ||
      typeof item.path !== "string" ||
      typeof item.sha256 !== "string"
    )
      return null;
    rows.push([item.target, item.path, item.sha256]);
  }
  return JSON.stringify(rows.sort((a, b) => a[0]!.localeCompare(b[0]!)));
}

export function validateCoverageShardUnion(input: CoverageUnionInput): string[] {
  if (!Array.isArray(input.shards) || !Array.isArray(input.native))
    return ["malformed coverage receipt/native collections"];
  const errors: string[] = [];
  const expected = new Set(input.canonicalScope);
  const runtimeScope = new Set(input.runtimeScope ?? input.canonicalScope);
  const owner = new Map<string, string>();
  const shardIds = new Set(input.wave.shards.map((shard) => shard.id));
  for (const shard of input.wave.shards)
    for (const target of shard.targets) {
      if (owner.has(target)) errors.push(`wave target has multiple owners: ${target}`);
      owner.set(target, shard.id);
    }
  for (const target of expected)
    if (!owner.has(target)) errors.push(`canonical target is missing from wave: ${target}`);
  for (const target of owner.keys())
    if (!expected.has(target)) errors.push(`wave has extra canonical target: ${target}`);
  const receipts = new Map<string, Record<string, unknown>>();
  const natives = new Map<string, Record<string, unknown>>();
  for (const [values, map, key, label] of [
    [input.shards, receipts, "shard_id", "receipt"],
    [input.native, natives, "id", "native"],
  ] as const) {
    for (const raw of values) {
      const value = record(raw);
      const id = value?.[key];
      if (!value || typeof id !== "string") {
        errors.push(`malformed coverage ${label}`);
        continue;
      }
      if (map.has(id)) errors.push(`duplicate coverage ${label}: ${id}`);
      if (!shardIds.has(id)) errors.push(`extra coverage ${label}: ${id}`);
      map.set(id, value);
    }
  }
  for (const shard of input.wave.shards) {
    const runtimeTargets = shard.targets.filter((target) => runtimeScope.has(target));
    const typeOnlyTargets = shard.targets.filter((target) => !runtimeScope.has(target));
    const receipt = receipts.get(shard.id);
    const native = natives.get(shard.id);
    const prefix = `coverage shard ${shard.id}`;
    if (!receipt) {
      errors.push(`${prefix} missing evidence`);
      continue;
    }
    for (const [key, value] of [
      ["version", 1],
      ["wave_id", input.wave.wave_id],
      ["run_id", input.runId],
      ["shard_id", shard.id],
      ["manifest_sha256", input.manifestSha256],
      ["source_sha256", input.sourceSha256],
      ["base_config_sha256", input.wave.config_sha256],
      ["test_sha256", input.wave.test_freeze_sha256],
      ["target_digest_sha256", input.wave.target_digest_sha256],
    ] as const)
      if (receipt[key] !== value) errors.push(`${prefix} ${key} mismatch`);
    if (JSON.stringify(receipt.targets) !== JSON.stringify(shard.targets))
      errors.push(`${prefix} targets mismatch`);
    if (
      input.runtimeScope !== undefined &&
      (JSON.stringify(receipt.runtime_targets) !== JSON.stringify(runtimeTargets) ||
        JSON.stringify(receipt.type_only_targets) !== JSON.stringify(typeOnlyTargets))
    )
      errors.push(`${prefix} runtime/type-only audit mismatch`);
    if (runtimeTargets.length === 0) {
      if (
        native ||
        receipt.not_applicable !== "type_only_ast" ||
        !Array.isArray(receipt.direct_target_evidence) ||
        receipt.direct_target_evidence.length !== 0
      )
        errors.push(`${prefix} type-only audit is not explicit`);
      continue;
    }
    if (!native) {
      errors.push(`${prefix} missing native evidence`);
      continue;
    }
    if (receipt.not_applicable !== undefined)
      errors.push(`${prefix} runtime coverage cannot be not applicable`);
    const latest = record(native.latest);
    const pointer = parse(latest?.contents);
    const nativeReceipt = parse(native.receiptText);
    const provenance = parse(native.provenanceText);
    if (
      !latest ||
      !pointer ||
      !nativeReceipt ||
      !provenance ||
      typeof native.lcovText !== "string"
    ) {
      errors.push(`${prefix} malformed native evidence`);
      continue;
    }
    if (
      typeof receipt.coverage_config_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(receipt.coverage_config_sha256) ||
      receipt.coverage_config_sha256 !== provenance.config_sha256
    )
      errors.push(`${prefix} coverage config mismatch`);
    if (
      typeof native.evidence_root !== "string" ||
      !isAbsolute(native.evidence_root) ||
      native.evidence_root !== resolve(native.evidence_root) ||
      latest.path !== join(native.evidence_root, "latest.json")
    )
      errors.push(`${prefix} unsafe evidence path`);
    if (hash(latest.contents as string) !== latest.sha256)
      errors.push(`${prefix} latest snapshot hash mismatch`);
    for (const [text, receiptKey] of [
      [native.receiptText, "native_receipt_sha256"],
      [native.provenanceText, "native_provenance_sha256"],
      [native.lcovText, "native_lcov_sha256"],
    ] as const)
      if (hash(text as string) !== receipt[receiptKey])
        errors.push(`${prefix} ${receiptKey} mismatch`);
    if (
      pointer.version !== 1 ||
      typeof pointer.run_id !== "string" ||
      !/^[a-z0-9-]{10,200}$/.test(pointer.run_id) ||
      pointer.receipt !== `runs/${pointer.run_id}/receipt.json` ||
      pointer.receipt_sha256 !== hash(native.receiptText as string) ||
      nativeReceipt.version !== 1 ||
      nativeReceipt.run_id !== pointer.run_id
    )
      errors.push(`${prefix} pointer receipt chain mismatch`);
    for (const [key, path, text] of [
      ["lcov", "lcov.info", native.lcovText],
      ["provenance", "provenance.json", native.provenanceText],
    ] as const) {
      const ref = record(nativeReceipt[key]);
      if (!ref || ref.path !== path || ref.sha256 !== hash(text as string))
        errors.push(`${prefix} native ${key} reference mismatch`);
    }
    for (const [key, value] of [
      ["version", 4],
      ["wave_id", input.wave.wave_id],
      ["shard_id", shard.id],
      ["manifest_sha256", input.manifestSha256],
      ["wave_source_freeze_sha256", input.sourceSha256],
      ["wave_test_freeze_sha256", input.wave.test_freeze_sha256],
      ["wave_target_digest_sha256", input.wave.target_digest_sha256],
      ["wave_base_config_sha256", input.wave.config_sha256],
    ] as const)
      if (provenance[key] !== value) errors.push(`${prefix} provenance ${key} mismatch`);
    const behaviorTests = planCoverageShardExecution({
      targets: runtimeTargets,
      tests: shard.tests,
      usesModuleMock: (test) =>
        readFileSync(join(input.repo, test), "utf8").includes("mock.module("),
    }).behaviorOnlyTests;
    const behavior = record(provenance.behavior_evidence);
    if (behaviorTests.length === 0) {
      if (behavior !== null) errors.push(`${prefix} has unexpected behavior evidence`);
    } else if (
      !behavior ||
      typeof behavior.text !== "string" ||
      typeof behavior.sha256 !== "string"
    )
      errors.push(`${prefix} has no behavior evidence`);
    else
      try {
        const group = planCoverageShardExecution({
          targets: runtimeTargets,
          tests: shard.tests,
          usesModuleMock: (test) =>
            readFileSync(join(input.repo, test), "utf8").includes("mock.module("),
        });
        const shared = input.wave.shards
          .filter(
            (candidate) =>
              JSON.stringify([...new Set(candidate.resource_tags)].sort()) ===
              JSON.stringify([...new Set(shard.resource_tags)].sort()),
          )
          .flatMap(
            (candidate) =>
              planCoverageShardExecution({
                targets: candidate.targets.filter((target) => runtimeScope.has(target)),
                tests: candidate.tests,
                usesModuleMock: (test) =>
                  readFileSync(join(input.repo, test), "utf8").includes("mock.module("),
              }).behaviorOnlyTests,
          );
        validateCoverageBehaviorProof({
          text: behavior.text,
          sha256: behavior.sha256,
          repo: input.repo,
          wave_id: input.wave.wave_id,
          manifest_sha256: input.manifestSha256,
          source_sha256: input.sourceSha256,
          test_sha256: input.wave.test_freeze_sha256,
          config_sha256: input.wave.config_sha256,
          resource_tags: shard.resource_tags,
          tests: group.behaviorOnlyTests,
          executed_tests: [...new Set(shared)].sort(),
        });
      } catch (error) {
        errors.push(`${prefix} behavior evidence rejected: ${String(error)}`);
      }
    const refs = references(receipt.direct_target_evidence);
    if (
      refs === null ||
      refs !== references(nativeReceipt.direct_target_evidence) ||
      refs !== references(provenance.direct_target_evidence)
    )
      errors.push(`${prefix} direct proof references mismatch`);
    if (!Array.isArray(receipt.direct_target_evidence)) {
      errors.push(`${prefix} malformed proofs`);
      continue;
    }
    const seen = new Set<string>();
    for (const raw of receipt.direct_target_evidence) {
      const proof = record(raw);
      if (
        !proof ||
        typeof proof.target !== "string" ||
        typeof proof.path !== "string" ||
        typeof proof.sha256 !== "string" ||
        typeof proof.lcov !== "string"
      ) {
        errors.push(`${prefix} malformed direct proof`);
        continue;
      }
      const target = proof.target;
      if (seen.has(target)) errors.push(`${prefix} duplicate proof: ${target}`);
      seen.add(target);
      if (!runtimeTargets.includes(target)) errors.push(`${prefix} extra direct proof: ${target}`);
      if (proof.path !== `targets/${hash(target)}.lcov` || hash(proof.lcov) !== proof.sha256) {
        errors.push(`${prefix} proof hash/path mismatch: ${target}`);
        continue;
      }
      const parsed = parseLcov(proof.lcov, input.repo);
      if ("error" in parsed || parsed.length !== 1 || parsed[0]?.file !== target) {
        errors.push(`${prefix} proof is not direct: ${target}`);
        continue;
      }
      const row = coverageRows(parsed)[0]!;
      if (!row.lines_total || !row.functions_total)
        errors.push(`${prefix} zero denominator: ${target}`);
      else if (row.lines !== 100 || row.funcs !== 100)
        errors.push(`${prefix} below 100: ${target}`);
    }
    for (const target of runtimeTargets)
      if (!seen.has(target)) errors.push(`${prefix} missing direct proof: ${target}`);
  }
  return errors;
}
