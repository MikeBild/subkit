#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedTestFile } from "../../sk/src/tests/run-isolated-test-file.ts";
import { parseShardArgs, runShardTests, selectCanonicalCoreTests } from "./audit/core-tests.ts";
import { createClosureAnalysis } from "./audit/mutation-closure.ts";
import { mutationClosureFiles, mutationTestInputs } from "./audit/mutation-inputs.ts";
import {
  readValidatedWaveManifest,
  validateWaveClosure,
  validateWaveFreeze,
} from "./audit/mutation-wave.ts";
import {
  assertCompletePureTargetInventory,
  canonicalPureTargetDigest,
  runtimePureTargetPaths,
} from "./audit/pure-targets.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const args = parseShardArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(args.error);
  process.exit(1);
}
let selected: string[];
let passthrough: string[];
let directTests: string[] = [];
if (args.mode === "shard") {
  if (args.passthrough.some((arg) => arg !== "--list")) {
    console.error("shard mode accepts no test narrowing flags or paths");
    process.exit(1);
  }
  const knownFiles = mutationClosureFiles(REPO);
  const entries = assertCompletePureTargetInventory(knownFiles);
  const typeOnlyTargets = entries
    .filter((entry) => entry.runtime_kind === "type_only")
    .map((entry) => entry.path);
  let manifest: ReturnType<typeof readValidatedWaveManifest>;
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
  const shard = manifest.shards.find((entry) => entry.id === args.shard);
  if (!shard) {
    console.error(`shard not found: ${args.shard}`);
    process.exit(1);
  }
  selected = shard.tests
    .filter((test) => test.execution !== "external_runtime")
    .map((test) => test.path);
  directTests = shard.tests
    .filter((test) => test.execution !== "external_runtime" && test.kind === "direct")
    .map((test) => test.path);
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
    await runShardTests(
      selected,
      (file) => runIsolatedTestFile(file, { cwd: REPO }),
      process.env.SUBKIT_MUTATION_FULL_CLOSURE === "1",
      directTests,
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
