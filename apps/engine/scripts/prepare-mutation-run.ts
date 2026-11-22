#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "./audit/files.ts";
import { digestFiles, mutationTestInputs } from "./audit/mutation-inputs.ts";
import { mutationGlobsMatch } from "./audit/mutation-scope.ts";
import {
  assertCompletePureTargetInventory,
  canonicalPureTargetDigest,
  runtimePureTargetPaths,
} from "./audit/pure-targets.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONFIG = join(REPO, "stryker.config.json");
const RECEIPT = join(REPO, ".reports/mutation/provenance.json");

function sha256(parts: readonly (string | Uint8Array)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

const configText = readFileSync(CONFIG, "utf8");
const config = JSON.parse(configText) as { mutate?: unknown };
if (!mutationGlobsMatch(config.mutate)) {
  throw new Error("stryker.config.json mutate list differs from the declared pure mutation scope");
}
const files = [
  "apps/cockpit/src",
  "apps/engine/src",
  "apps/subkit/src",
  "packages/shared/src",
  "packages/cli-core/src",
].flatMap((root) =>
  listFiles(join(REPO, root), (file) => file.endsWith(".ts")).map((file) => relative(REPO, file)),
);
const canonicalTargets = assertCompletePureTargetInventory(files);
const canonicalScope = canonicalTargets.map((target) => target.path);
const scope = runtimePureTargetPaths(canonicalTargets);
const typeOnlyScope = canonicalScope.filter((target) => !scope.includes(target));
if (scope.length === 0) throw new Error("runtime pure mutation scope is empty");
const sourceDigest = sha256(
  canonicalScope.flatMap((file) => [file, "\0", readFileSync(join(REPO, file)), "\0"]),
);
const testInputs = mutationTestInputs(REPO);
const receipt = {
  version: 1,
  created_at: new Date().toISOString(),
  config_sha256: sha256([configText]),
  source_sha256: sourceDigest,
  test_sha256: digestFiles(REPO, testInputs, sha256),
  canonical_target_count: canonicalTargets.length,
  canonical_target_sha256: canonicalPureTargetDigest(canonicalTargets),
  scope,
  type_only_scope: typeOnlyScope,
  tests: testInputs,
};
mkdirSync(dirname(RECEIPT), { recursive: true });
writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`prepared mutation receipt for ${scope.length} pure files`);
