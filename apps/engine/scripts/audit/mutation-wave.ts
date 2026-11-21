import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isExternalRuntimeDockerTest,
  type TestExecutionKind,
  testExecutionKind,
} from "./external-runtime-tests.ts";
import { createClosureAnalysis, reviewedClosurePlanFromAnalysis } from "./mutation-closure.ts";
import { assertWaveMatchesQualityPolicy, parseQualityShardPolicy } from "./quality-shard-policy.ts";
import { REEXPORT_BARREL_EXCLUSION, reexportBarrelExclusion } from "./reexport-barrel.ts";
import { reviewedRuntimeWitnesses } from "./runtime-witnesses.ts";

export type ClosureKind =
  | "direct"
  | "reverse_import"
  | "shared_consumer"
  | "barrel_contract"
  | "consumer_contract"
  | "integration";

export interface WaveTest {
  path: string;
  kind: ClosureKind;
  covers_targets: readonly string[];
  rationale: string;
  execution?: TestExecutionKind;
}

export interface WaveConsumer {
  path: string;
  witnesses: readonly string[];
  exclusion_rationale?: string;
}

export interface MutationWaveShard {
  id: string;
  targets: readonly string[];
  tests: readonly WaveTest[];
  consumers: readonly WaveConsumer[];
  resource_tags: readonly string[];
}

export interface MutationWaveManifest {
  version: 1;
  wave_id: string;
  source_freeze_sha256: string;
  test_freeze_sha256: string;
  target_digest_sha256: string;
  config_sha256: string;
  quality_policy_sha256?: string;
  lock_sha256: string;
  equivalence_manifest_sha256: string;
  dynamic_import_ledger_sha256: string;
  runtime_artifact_digest_sha256?: string;
  dynamic_import_ledger_path: string;
  equivalence_manifest_path: string;
  non_incremental: true;
  worker_budget: number;
  external_runtime_tests?: readonly string[];
  shards: readonly MutationWaveShard[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function isCanonicalRepoPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.startsWith("./") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

export function digestCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function digestWaveFiles(repo: string, files: readonly string[]): string {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(repo, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function validateWaveFreeze(input: {
  repo: string;
  manifest: MutationWaveManifest;
  runtime_inputs: readonly string[];
  instrumented_targets?: boolean;
}): string[] {
  const tests = input.manifest.shards.flatMap((shard) => shard.tests.map((test) => test.path));
  const checks: Array<[string, string, string]> = [
    ["test", digestWaveFiles(input.repo, tests), input.manifest.test_freeze_sha256],
    ["config", digestWaveFiles(input.repo, ["stryker.config.json"]), input.manifest.config_sha256],
    ["lock", digestWaveFiles(input.repo, ["bun.lock"]), input.manifest.lock_sha256],
    [
      "equivalence",
      digestWaveFiles(input.repo, [input.manifest.equivalence_manifest_path]),
      input.manifest.equivalence_manifest_sha256,
    ],
    [
      "dynamic ledger",
      digestWaveFiles(input.repo, [input.manifest.dynamic_import_ledger_path]),
      input.manifest.dynamic_import_ledger_sha256,
    ],
  ];
  if (input.manifest.quality_policy_sha256 !== undefined) {
    const path = "apps/engine/.quality-shard-policy.json";
    checks.push([
      "quality policy",
      digestWaveFiles(input.repo, [path]),
      input.manifest.quality_policy_sha256,
    ]);
    const policy = parseQualityShardPolicy(
      JSON.parse(readFileSync(join(input.repo, path), "utf8")),
      input.manifest.shards.map((shard) => shard.id),
    );
    assertWaveMatchesQualityPolicy(policy, input.manifest);
  }
  if (!input.instrumented_targets)
    checks.push([
      "source",
      digestWaveFiles(input.repo, input.runtime_inputs),
      input.manifest.source_freeze_sha256,
    ]);
  return checks.filter(([, actual, expected]) => actual !== expected).map(([label]) => label);
}

export function validateMutationWaveManifest(input: {
  manifest: unknown;
  canonical_targets: readonly string[];
  canonical_target_digest: string;
  known_files: readonly string[];
  type_only_targets?: readonly string[];
}): string[] {
  const errors: string[] = [];
  if (!input.manifest || typeof input.manifest !== "object")
    return ["wave manifest is not an object"];
  const manifest = input.manifest as Partial<MutationWaveManifest>;
  if (manifest.version !== 1) errors.push("wave manifest version must equal 1");
  if (typeof manifest.wave_id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.wave_id))
    errors.push("wave manifest has invalid wave_id");
  for (const key of [
    "source_freeze_sha256",
    "test_freeze_sha256",
    "target_digest_sha256",
    "config_sha256",
    "lock_sha256",
    "equivalence_manifest_sha256",
    "dynamic_import_ledger_sha256",
  ] as const)
    if (!SHA256.test(manifest[key] ?? "")) errors.push(`wave manifest ${key} must be sha256`);
  if (manifest.quality_policy_sha256 !== undefined && !SHA256.test(manifest.quality_policy_sha256))
    errors.push("wave manifest quality_policy_sha256 must be sha256");
  if (
    manifest.runtime_artifact_digest_sha256 !== undefined &&
    !SHA256.test(manifest.runtime_artifact_digest_sha256)
  )
    errors.push("wave manifest runtime_artifact_digest_sha256 must be sha256");
  for (const key of ["dynamic_import_ledger_path", "equivalence_manifest_path"] as const)
    if (!isCanonicalRepoPath(manifest[key]))
      errors.push(`wave manifest ${key} must be canonical path`);
  if (manifest.non_incremental !== true)
    errors.push("wave manifest non_incremental must equal true");
  if (!Number.isInteger(manifest.worker_budget) || (manifest.worker_budget ?? 0) < 1)
    errors.push("wave manifest worker_budget must be a positive integer");
  if (!Array.isArray(manifest.shards) || manifest.shards.length === 0) {
    errors.push("wave manifest has no shards");
    return errors;
  }
  const expected = new Set(input.canonical_targets);
  const typeOnly = new Set(input.type_only_targets ?? []);
  const known = new Set(input.known_files);
  const externalRuntimeTests = input.known_files.filter(isExternalRuntimeDockerTest).sort();
  const declaredExternal = manifest.external_runtime_tests;
  if (
    externalRuntimeTests.length > 0 &&
    (!Array.isArray(declaredExternal) ||
      JSON.stringify([...declaredExternal].sort()) !== JSON.stringify(externalRuntimeTests))
  )
    errors.push(
      "wave manifest external runtime test inventory differs from canonical Docker discovery",
    );
  const owned = new Map<string, string>();
  const shardIds = new Set<string>();
  for (const shard of manifest.shards) {
    if (!shard || typeof shard !== "object") {
      errors.push("wave manifest has malformed shard");
      continue;
    }
    if (
      typeof shard.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(shard.id) ||
      shardIds.has(shard.id)
    )
      errors.push(`wave manifest has duplicate or invalid shard id: ${String(shard.id)}`);
    shardIds.add(shard.id);
    const shardTargets: unknown[] = Array.isArray(shard.targets) ? shard.targets : [];
    if (!Array.isArray(shard.targets) || shardTargets.length === 0)
      errors.push(`shard ${shard.id} has no targets`);
    for (const target of shardTargets) {
      if (!isCanonicalRepoPath(target) || !expected.has(target))
        errors.push(`shard ${shard.id} has non-canonical or unexpected target: ${String(target)}`);
      else if (owned.has(target)) errors.push(`target has multiple owners: ${target}`);
      else owned.set(target, shard.id);
    }
    const runtimeTargets = shardTargets.filter(
      (target): target is string => typeof target === "string" && !typeOnly.has(target),
    );
    if ((!Array.isArray(shard.tests) || shard.tests.length === 0) && runtimeTargets.length > 0)
      errors.push(`shard ${shard.id} has no reviewed tests`);
    const tests = new Set<string>();
    for (const test of Array.isArray(shard.tests) ? shard.tests : []) {
      if (!test || typeof test !== "object") {
        errors.push(`shard ${shard.id} has malformed test`);
        continue;
      }
      if (!isCanonicalRepoPath(test.path) || !TEST.test(test.path) || !known.has(test.path))
        errors.push(`shard ${shard.id} has missing or invalid test: ${String(test.path)}`);
      if (tests.has(test.path)) errors.push(`shard ${shard.id} has duplicate test: ${test.path}`);
      tests.add(test.path);
      if (typeof test.rationale !== "string" || !test.rationale.trim())
        errors.push(`shard ${shard.id} test has no rationale: ${test.path}`);
      const expectedExecution = testExecutionKind(test.path, externalRuntimeTests);
      if (
        (expectedExecution === "external_runtime" && test.execution !== expectedExecution) ||
        (test.execution !== undefined && test.execution !== expectedExecution)
      )
        errors.push(
          `shard ${shard.id} test execution kind differs from canonical classification: ${test.path}`,
        );
      if (
        !(
          [
            "direct",
            "reverse_import",
            "shared_consumer",
            "barrel_contract",
            "consumer_contract",
            "integration",
          ] as string[]
        ).includes(test.kind)
      )
        errors.push(`shard ${shard.id} test has invalid closure kind: ${test.path}`);
      for (const target of Array.isArray(test.covers_targets) ? test.covers_targets : [])
        if (!shardTargets.includes(target))
          errors.push(`shard ${shard.id} test covers foreign target: ${target}`);
    }
    for (const target of runtimeTargets)
      if (
        ![...tests].some((path) =>
          (Array.isArray(shard.tests) ? shard.tests : []).some((test: unknown) => {
            if (!test || typeof test !== "object") return false;
            const candidate = test as Partial<WaveTest>;
            return (
              candidate.path === path &&
              Array.isArray(candidate.covers_targets) &&
              candidate.covers_targets.includes(target)
            );
          }),
        )
      )
        errors.push(`shard ${shard.id} target has no reviewed test: ${target}`);
    if (!Array.isArray(shard.consumers)) errors.push(`shard ${shard.id} has malformed consumers`);
    for (const consumer of Array.isArray(shard.consumers) ? shard.consumers : []) {
      if (!consumer || typeof consumer !== "object") {
        errors.push(`shard ${shard.id} has malformed consumer`);
        continue;
      }
      if (!isCanonicalRepoPath(consumer.path) || !known.has(consumer.path))
        errors.push(`shard ${shard.id} has invalid consumer: ${String(consumer.path)}`);
      const witnesses = Array.isArray(consumer.witnesses) ? consumer.witnesses : [];
      if (witnesses.length === 0 && consumer.exclusion_rationale !== REEXPORT_BARREL_EXCLUSION)
        errors.push(`consumer has no witness or reviewed exclusion: ${consumer.path}`);
      for (const witness of witnesses)
        if (!tests.has(witness))
          errors.push(`consumer witness is not a shard test: ${consumer.path} -> ${witness}`);
    }
    if (
      !Array.isArray(shard.resource_tags) ||
      !shard.resource_tags.every(
        (tag: unknown) => typeof tag === "string" && /^[a-z][a-z0-9-]*$/.test(tag),
      ) ||
      new Set(shard.resource_tags).size !== shard.resource_tags.length
    )
      errors.push(`shard ${shard.id} has duplicate or malformed resource tags`);
  }
  for (const target of expected)
    if (!owned.has(target)) errors.push(`canonical target has no owner: ${target}`);
  for (const target of owned.keys())
    if (!expected.has(target)) errors.push(`unexpected owned target: ${target}`);
  if (manifest.target_digest_sha256 !== input.canonical_target_digest)
    errors.push("wave manifest target digest differs from canonical targets");
  return errors;
}

export function validateWaveClosure(input: {
  repo: string;
  wave: MutationWaveManifest;
  files: readonly string[];
  type_only_targets?: readonly string[];
}): string[] {
  const errors: string[] = [];
  const read = (path: string) => {
    try {
      return readFileSync(join(input.repo, path), "utf8");
    } catch {
      return null;
    }
  };
  const tsconfig = read("tsconfig.json") ?? "{}";
  let ledger: unknown;
  try {
    ledger = JSON.parse(read(input.wave.dynamic_import_ledger_path) ?? "null");
  } catch {
    return ["invalid runtime witness ledger JSON"];
  }
  const runtime = reviewedRuntimeWitnesses({
    ledger,
    files: input.files,
    readText: read,
    readArtifact: read,
  });
  errors.push(...runtime.errors);
  const cockpit = read("apps/cockpit/tsconfig.json") ?? "{}";
  const typeOnly = new Set(input.type_only_targets ?? []);
  const analysis = createClosureAnalysis({
    files: input.files,
    readText: read,
    tsconfig,
    cockpitTsconfig: cockpit,
  });
  for (const shard of input.wave.shards) {
    const actual = reviewedClosurePlanFromAnalysis(analysis, {
      targets: shard.targets.filter((target) => !typeOnly.has(target)),
      declared: [],
    });
    const declaredTests = new Set(shard.tests.map((test) => test.path));
    for (const declared of shard.tests) {
      if (declared.kind !== "direct") continue;
      const inferred = actual.tests.find((test) => test.path === declared.path);
      if (
        inferred?.kind !== "direct" ||
        declared.covers_targets.some((target) => !inferred.covers_targets.includes(target))
      )
        errors.push(`shard ${shard.id} direct test has no target import: ${declared.path}`);
    }
    const declaredConsumers = new Map(shard.consumers.map((consumer) => [consumer.path, consumer]));
    for (const test of actual.tests)
      if (!declaredTests.has(test.path))
        errors.push(`shard ${shard.id} omits runtime closure test: ${test.path}`);
    for (const consumer of actual.consumers) {
      const declared = declaredConsumers.get(consumer.path);
      if (!declared) errors.push(`shard ${shard.id} omits production consumer: ${consumer.path}`);
      else if (
        declared.exclusion_rationale !== undefined &&
        declared.exclusion_rationale !== reexportBarrelExclusion(consumer.path, read(consumer.path))
      )
        errors.push(
          `shard ${shard.id} consumer exclusion is not a re-export barrel: ${consumer.path}`,
        );
      else if (
        !declared.exclusion_rationale &&
        !declared.witnesses.some(
          (witness) =>
            declaredTests.has(witness) &&
            (consumer.witnesses.includes(witness) ||
              runtime.witnesses.get(consumer.path)?.has(witness)),
        )
      )
        errors.push(`shard ${shard.id} consumer has no executable witness: ${consumer.path}`);
    }
  }
  return errors;
}

export function readValidatedWaveManifest(input: {
  text: string;
  canonical_targets: readonly string[];
  canonical_target_digest: string;
  known_files: readonly string[];
  type_only_targets?: readonly string[];
}): MutationWaveManifest {
  let manifest: unknown;
  try {
    manifest = JSON.parse(input.text);
  } catch (error) {
    throw new Error(
      `wave manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const errors = validateMutationWaveManifest({ ...input, manifest });
  if (errors.length > 0) throw new Error(`invalid mutation wave:\n${errors.join("\n")}`);
  return manifest as MutationWaveManifest;
}
