#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localDatabaseUrl } from "../../../scripts/lib/local-database-url.ts";
import {
  aggregateByPrefix,
  type CoverageRow,
  type FloorEntry,
  judgeFile,
  parseCoverageTable,
  parseFloorFile,
  relatedTests,
  resolveFileFloors,
  testCandidates,
} from "./audit/coverage-floor.ts";
import { listFiles } from "./audit/files.ts";

const __filename = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(__filename), "..", "..", "..");

const isSource = (p: string) =>
  p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts") && !p.includes("/tests/");

function countLines(file: string): number {
  try {
    return readFileSync(join(REPO, file), "utf8").split("\n").length;
  } catch {
    return 0;
  }
}

function runCoverage(targets: readonly string[]): CoverageRow[] {
  const result = spawnSync("bun", ["test", ...targets, "--coverage"], {
    cwd: REPO,
    env: {
      ...process.env,
      NODE_ENV: "test",
      SKIP_DOCKER: "1",
      DATABASE_URL: localDatabaseUrl(process.env),
      MASTER_KEY:
        process.env.MASTER_KEY ??
        "00000000000000000000000000000000000000000000000000000000000000aa",
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseCoverageTable(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

function testsFor(file: string, floor: FloorEntry): string[] {
  if (floor.tests && floor.tests.length > 0) return floor.tests;
  const direct = testCandidates(file).filter((candidate) => existsSync(join(REPO, candidate)));
  const siblings = readdirSync(join(REPO, dirname(file)));
  return [...new Set([...direct, ...relatedTests(file, siblings)])];
}

const parsed = parseFloorFile(
  JSON.parse(readFileSync(join(REPO, "apps/engine/.coverage-floor.json"), "utf8")),
);
if ("errors" in parsed) {
  console.error(`.coverage-floor.json invalid:\n  ${parsed.errors.join("\n  ")}`);
  process.exit(1);
}
const { floors } = parsed;

const want = [...process.argv.slice(2)];
const wanted = (name: string): boolean =>
  want.length === 0 ||
  want.some((w) => w === name || w === name.split("/").pop() || name.startsWith(`${w}/`));

interface Result {
  target: string;
  status: "PASS" | "FAIL" | "SKIP";
  message: string;
}
const results: Result[] = [];

for (const [subsystem, floor] of Object.entries(floors.subsystems)) {
  if (!wanted(subsystem)) continue;
  if (floor.line_min === 0 && floor.branch_min === 0) {
    results.push({
      target: subsystem,
      status: "SKIP",
      message: `floor=${floor.line_min}/${floor.branch_min} (deferred — see rationale)`,
    });
    continue;
  }
  if (listFiles(join(REPO, subsystem), isSource).length === 0) {
    results.push({
      target: subsystem,
      status: "SKIP",
      message: "no source files under this directory",
    });
    continue;
  }
  const line = aggregateByPrefix(runCoverage([subsystem]), subsystem, countLines);
  if (line === null) {
    results.push({
      target: subsystem,
      status: "FAIL",
      message: "no coverage rows matched the subsystem path; did the test target shrink?",
    });
  } else {
    results.push({
      target: subsystem,
      status: line < floor.line_min ? "FAIL" : "PASS",
      message: `line=${line.toFixed(2)} (${line < floor.line_min ? "<" : ">="}${floor.line_min})`,
    });
  }
}

const sourceFiles = ["apps/engine/src", "apps/sk/src", "packages"].flatMap((root) =>
  listFiles(join(REPO, root), isSource).map((abs) => relative(REPO, abs)),
);
for (const [file, floor] of resolveFileFloors(floors, sourceFiles)) {
  if (!wanted(file)) continue;
  if (!existsSync(join(REPO, file))) {
    results.push({
      target: file,
      status: "FAIL",
      message: "file listed in `files` does not exist",
    });
    continue;
  }
  const tests = testsFor(file, floor);
  if (tests.length === 0) {
    results.push({
      target: file,
      status: "FAIL",
      message: `no test file found (looked for ${testCandidates(file).join(", ")}; or set \`tests\`)`,
    });
    continue;
  }
  results.push({ target: file, ...judgeFile(file, floor, runCoverage(tests)) });
}

let pass = 0;
let fail = 0;
let skip = 0;
for (const r of results) {
  console.log(`${r.status.padEnd(4)} ${r.target.padEnd(36)} ${r.message}`);
  if (r.status === "PASS") pass++;
  else if (r.status === "FAIL") fail++;
  else skip++;
}
console.log(`\n${pass} pass, ${fail} fail, ${skip} skip`);

process.exit(fail === 0 ? 0 : 1);
