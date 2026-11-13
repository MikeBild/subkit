#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mutationClosureFiles, mutationTestInputs } from "./audit/mutation-inputs.ts";
import { mutationRuntimeArtifactDigest } from "./audit/mutation-runtime-snapshot.ts";
import {
  type MutationWaveManifest,
  validateMutationWaveManifest,
  validateWaveClosure,
} from "./audit/mutation-wave.ts";
import {
  assertCompletePureTargetInventory,
  canonicalPureTargetDigest,
} from "./audit/pure-targets.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function digest(files: readonly string[]): string {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(REPO, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function required(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path`);
  return value;
}

const input = required("--manifest");
const output = required("--out");
const ledger = required("--dynamic-ledger");
const manifest = JSON.parse(readFileSync(join(REPO, input), "utf8")) as MutationWaveManifest;
const known = mutationClosureFiles(REPO);
const entries = assertCompletePureTargetInventory(known);
const targets = entries.map((target) => target.path);
const typeOnlyTargets = entries
  .filter((entry) => entry.runtime_kind === "type_only")
  .map((entry) => entry.path);
const frozen: MutationWaveManifest = {
  ...manifest,
  source_freeze_sha256: digest(mutationTestInputs(REPO)),
  test_freeze_sha256: digest(
    manifest.shards.flatMap((shard) => shard.tests.map((test) => test.path)),
  ),
  target_digest_sha256: canonicalPureTargetDigest(entries),
  config_sha256: digest(["stryker.config.json"]),
  lock_sha256: digest(["bun.lock"]),
  equivalence_manifest_sha256: digest([manifest.equivalence_manifest_path]),
  dynamic_import_ledger_sha256: digest([ledger]),
  dynamic_import_ledger_path: ledger,
  runtime_artifact_digest_sha256: mutationRuntimeArtifactDigest(REPO),
};
const errors = validateMutationWaveManifest({
  manifest: frozen,
  canonical_targets: targets,
  canonical_target_digest: canonicalPureTargetDigest(entries),
  known_files: known,
  type_only_targets: typeOnlyTargets,
});
errors.push(
  ...validateWaveClosure({
    repo: REPO,
    wave: frozen,
    files: known,
    type_only_targets: typeOnlyTargets,
  }),
);
if (errors.length > 0) throw new Error(`invalid frozen mutation wave:\n${errors.join("\n")}`);
mkdirSync(dirname(join(REPO, output)), { recursive: true });
writeFileSync(join(REPO, output), `${JSON.stringify(frozen, null, 2)}\n`);
console.log(
  `prepared ${frozen.wave_id}: ${targets.length} targets, ${frozen.shards.length} shards`,
);
