#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "./audit/files.ts";
import {
  judgeScores,
  readBreakThreshold,
  readMutationEquivalentManifest,
  readReportPath,
  renderScore,
  scoreFiles,
  validateMutationEquivalents,
  validateMutationProvenance,
  validateMutationRunConfig,
  validateMutationThresholds,
} from "./audit/mutation-floor.ts";
import { digestFiles, mutationTestInputs } from "./audit/mutation-inputs.ts";
import { MUTATION_GLOBS, mutationGlobsMatch } from "./audit/mutation-scope.ts";
import {
  assertCompletePureTargetInventory,
  canonicalPureTargetDigest,
  runtimePureTargetPaths,
} from "./audit/pure-targets.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(parts: readonly (string | Uint8Array)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

const configPath = join(REPO, "stryker.config.json");
const configText = readFileSync(configPath, "utf8");
const config = JSON.parse(configText) as { mutate?: unknown };
if (!mutationGlobsMatch(config.mutate)) {
  console.error("stryker.config.json mutate list differs from the declared pure mutation scope");
  process.exit(1);
}
const threshold = readBreakThreshold(config);
const thresholdErrors = validateMutationThresholds(config);
if (threshold === null || thresholdErrors.length > 0) {
  console.error(
    thresholdErrors.join("\n") || "stryker.config.json has no numeric thresholds.break",
  );
  process.exit(1);
}
const reportPath = join(REPO, readReportPath(config, "reports/mutation/mutation.json"));
const receiptPath = join(REPO, "reports/mutation/provenance.json");
const equivalentsPath = join(REPO, "apps/engine/.mutation-equivalents.json");
let report: unknown;
try {
  report = readJson(reportPath);
} catch (err) {
  console.error(
    `mutation report missing or unreadable at ${reportPath}: ${(err as Error).message}`,
  );
  console.error("run `bunx stryker run --force` first");
  process.exit(1);
}
let receipt: unknown;
try {
  receipt = readJson(receiptPath);
} catch (err) {
  console.error(
    `mutation provenance receipt missing or unreadable at ${receiptPath}: ${(err as Error).message}`,
  );
  console.error("run `bun run apps/engine/scripts/prepare-mutation-run.ts` before Stryker");
  process.exit(1);
}
let equivalents: unknown;
try {
  equivalents = readJson(equivalentsPath);
} catch (err) {
  console.error(
    `mutation equivalence manifest missing or unreadable at ${equivalentsPath}: ${(err as Error).message}`,
  );
  process.exit(1);
}
if (statSync(reportPath).mtimeMs < statSync(receiptPath).mtimeMs) {
  console.error("mutation report predates its provenance receipt");
  process.exit(1);
}
const runConfigErrors = validateMutationRunConfig({ config, report });
if (runConfigErrors.length > 0) {
  console.error(`mutation run config invalid:\n  ${runConfigErrors.join("\n  ")}`);
  process.exit(1);
}
const candidates = [
  "apps/cockpit/src",
  "apps/engine/src",
  "apps/sk/src",
  "packages/shared/src",
  "packages/cli-core/src",
].flatMap((root) =>
  listFiles(join(REPO, root), (file) => file.endsWith(".ts")).map((file) => relative(REPO, file)),
);
const canonicalTargets = assertCompletePureTargetInventory(candidates);
const canonicalScope = canonicalTargets.map((target) => target.path);
const scope = runtimePureTargetPaths(canonicalTargets);
const typeOnlyScope = canonicalScope.filter((target) => !scope.includes(target));
const sourceSha256 = sha256(
  canonicalScope.flatMap((file) => [file, "\0", readFileSync(join(REPO, file)), "\0"]),
);
const testSha256 = digestFiles(REPO, mutationTestInputs(REPO), sha256);
const provenanceErrors = validateMutationProvenance({
  report,
  receipt,
  expectedScope: scope,
  expectedMutate: MUTATION_GLOBS,
  configSha256: sha256([configText]),
  sourceSha256,
  testSha256,
  canonicalTargetCount: canonicalTargets.length,
  canonicalTargetSha256: canonicalPureTargetDigest(canonicalTargets),
  expectedTypeOnlyScope: typeOnlyScope,
  repo: REPO,
});
if (provenanceErrors.length > 0) {
  console.error(`mutation provenance invalid:\n  ${provenanceErrors.join("\n  ")}`);
  process.exit(1);
}
const manifest = readMutationEquivalentManifest(equivalents, REPO);
if ("error" in manifest) {
  console.error(`mutation equivalence manifest invalid: ${manifest.error}`);
  process.exit(1);
}
const equivalence = validateMutationEquivalents({
  report,
  manifest,
  repo: REPO,
  expectedScope: scope,
  sourceSha256ForFile: (file) => {
    try {
      return sha256([readFileSync(join(REPO, file))]);
    } catch {
      return null;
    }
  },
});
if (equivalence.errors.length > 0) {
  console.error(`mutation equivalence validation failed:\n  ${equivalence.errors.join("\n  ")}`);
  process.exit(1);
}
const scores = scoreFiles(
  report,
  REPO,
  equivalence.matches.map((match) => match.mutant),
);
if ("error" in scores) {
  console.error(`mutation report invalid: ${scores.error}`);
  process.exit(1);
}
if (scores.length === 0) {
  console.error("mutation report lists no mutated files");
  process.exit(1);
}
const verdict = judgeScores(scores, threshold);
for (const score of verdict.failed) console.log(`FAIL ${renderScore(score)}`);
const equivalentExcluded = scores.reduce(
  (total, score) => total + (score.equivalent_excluded ?? 0),
  0,
);
if (equivalentExcluded > 0)
  console.log(
    `raw report contains ${equivalentExcluded} reviewed Ignored mutant(s); excluded from adjusted score (not killed)`,
  );
console.log(
  `\n${verdict.passed.length} file(s) at or above ${threshold} %, ${verdict.failed.length} below`,
);
process.exit(verdict.failed.length === 0 ? 0 : 1);
