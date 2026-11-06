#!/usr/bin/env bun

import path from "node:path";
import { type RunOutcome, runPool, summarize } from "../apps/engine/scripts/audit/import-graph.ts";
import { loadTestLayers, readRepoText } from "../apps/engine/scripts/audit/test-layer-source.ts";
import { isLayer, LAYERS, planRuns, RUNNERS } from "../apps/engine/scripts/audit/test-layers.ts";

const REPO = path.resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const list = argv.includes("--list");
const positional = argv.filter((a) => !a.startsWith("--"));
const unknown = argv.filter((a) => a.startsWith("--") && a !== "--list");
const layer = positional[0];
if (!layer || !isLayer(layer) || positional.length > 1 || unknown.length > 0) {
  console.error(`usage: bun run scripts/test-layer.ts <${LAYERS.join("|")}> [--list]`);
  process.exit(2);
}
const workers = Number(process.env.SUBKIT_TEST_WORKERS ?? "1");
if (!Number.isInteger(workers) || workers < 1) {
  console.error("SUBKIT_TEST_WORKERS must be a positive integer");
  process.exit(2);
}

const files = loadTestLayers(REPO)[layer];
if (list) {
  for (const file of files) console.log(file);
  process.exit(0);
}
if (files.length === 0) {
  console.log(`no ${layer} test files`);
  process.exit(0);
}

const runner = RUNNERS[layer];

async function run(label: string, targets: readonly string[]): Promise<RunOutcome> {
  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: "test" };
  env.LLM_PROVIDER ??= "mock";
  if (runner.skipDocker) env.SKIP_DOCKER = "1";
  const child = Bun.spawn(
    ["bun", "test", "--timeout", String(runner.timeoutMs), ...targets.map((t) => `./${t}`)],
    { cwd: REPO, env, stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await child.exited;
  process.stdout.write(`[test-layer] ${exitCode === 0 ? "PASS" : "FAIL"} ${label}\n`);
  return { file: label, exitCode, output: "" };
}

const plan = planRuns(files, runner, (file) => readRepoText(REPO, file));
const outcomes = [
  ...(await runPool(plan.groups, 1, (group) =>
    run(`${group.root} (${group.files.length} files)`, group.files),
  )),
  ...(await runPool(plan.solo, workers, (file) => run(file, [file]))),
];
const summary = summarize(outcomes);
console.log(`\n[test-layer] ${layer}: ${summary.text}`);
process.exit(summary.failed === 0 ? 0 : 1);
