#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  judgeScores,
  readBreakThreshold,
  readReportPath,
  renderScore,
  scoreFiles,
} from "./audit/mutation-floor.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const config = readJson(join(REPO, "stryker.config.json"));
const threshold = readBreakThreshold(config);
if (threshold === null) {
  console.error("stryker.config.json has no numeric thresholds.break");
  process.exit(1);
}
const reportPath = join(REPO, readReportPath(config, "reports/mutation/mutation.json"));
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
const scores = scoreFiles(report, REPO);
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
console.log(
  `\n${verdict.passed.length} file(s) at or above ${threshold} %, ${verdict.failed.length} below`,
);
process.exit(verdict.failed.length === 0 ? 0 : 1);
