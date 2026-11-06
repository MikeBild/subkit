#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  type AliasScope,
  buildReverseGraph,
  diffArgs,
  isTestFile,
  parseAffectedArgs,
  parseTsconfigPaths,
  type RunOutcome,
  runPool,
  selectAffected,
  summarize,
} from "../apps/engine/scripts/audit/import-graph.ts";

const REPO = path.resolve(import.meta.dir, "..");
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const ROOTS = /^(?:apps|packages|scripts|tests)\//;
const SKIPPED = /(?:^|\/)(?:node_modules|dist|\.stryker-tmp)\//;
const MAX_BYTES = 1024 * 1024;
const TSCONFIGS = ["tsconfig.json", "apps/cockpit/tsconfig.json"];

function git(args: readonly string[]): string[] {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function exists(rel: string): boolean {
  return existsSync(path.join(REPO, rel));
}

function readText(rel: string): string | null {
  const abs = path.join(REPO, rel);
  try {
    if (statSync(abs).size > MAX_BYTES) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function aliasScopes(): AliasScope[] {
  return TSCONFIGS.filter(exists).map((file) =>
    parseTsconfigPaths(
      path.posix.dirname(file) === "." ? "" : path.posix.dirname(file),
      readFileSync(path.join(REPO, file), "utf8"),
    ),
  );
}

async function runTest(file: string): Promise<RunOutcome> {
  const env = { ...process.env, NODE_ENV: "test" };
  env.LLM_PROVIDER ??= "mock";
  const child = Bun.spawn(["bun", "test", "--timeout", "120000", `./${file}`], {
    cwd: REPO,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  process.stdout.write(`${exitCode === 0 ? "PASS" : "FAIL"} ${file}\n`);
  return { file, exitCode, output: `${stdout}${stderr}` };
}

const args = parseAffectedArgs(process.argv.slice(2), process.env);
if ("error" in args) {
  console.error(args.error);
  console.error(
    "usage: bun run scripts/affected-tests.ts [--list] [--depth <n>] [--workers <n>] [<git-range>]",
  );
  process.exit(2);
}

const changed = [
  ...new Set([
    ...git(diffArgs(args.range)),
    ...(args.range === null ? git(["ls-files", "--others", "--exclude-standard"]) : []),
  ]),
].sort();
const files = git(["ls-files", "--cached", "--others", "--exclude-standard"]).filter(
  (f) => SOURCE.test(f) && ROOTS.test(f) && !SKIPPED.test(f) && exists(f),
);
const reverse = buildReverseGraph(files, readText, aliasScopes(), exists);
const selection = selectAffected({
  changed,
  testFiles: files.filter(isTestFile),
  reverse,
  depth: args.depth,
});

if (args.list) {
  for (const test of selection.tests) console.log(test);
  process.exit(0);
}
if (selection.tests.length === 0) {
  console.log(`no affected tests for ${changed.length} changed file(s)`);
  process.exit(0);
}
console.log(
  `${selection.tests.length} affected test file(s) for ${changed.length} changed file(s), ${args.workers} worker(s)`,
);
const outcomes = await runPool(selection.tests, args.workers, runTest);
const summary = summarize(outcomes);
for (const outcome of outcomes.filter((o) => o.exitCode !== 0)) {
  console.log(`\n--- ${outcome.file} ---\n${outcome.output.split("\n").slice(-40).join("\n")}`);
}
console.log(`\n${summary.text}`);
process.exit(summary.failed === 0 ? 0 : 1);
