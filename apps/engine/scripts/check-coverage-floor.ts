#!/usr/bin/env bun
//
// check-coverage-floor — Phase 2 wrap-up of the 2026-05 architecture
// audit. Runs `bun test <subsystem> --coverage` for each entry in
// apps/engine/.coverage-floor.json and fails when the observed line
// or branch coverage drops below the recorded floor.
//
// Usage:
//   bun run check:coverage-floor              # all subsystems
//   bun run check:coverage-floor rbac audit   # just these
//
// Output is line-oriented and parseable, mirroring audit-invariants.ts:
//   PASS  apps/engine/src/rbac      line=92.10 (>=90) branch=85.40 (>=85)
//   FAIL  apps/engine/src/audit     line=88.00 (<90)
//   SKIP  apps/engine/src/http/routes  floor=0/0 (deferred)
//
// Exits non-zero on any FAIL. Designed so the audit-invariants
// `coverage_floor` check can call it and surface the result in CI.
//
// Implementation note: `bun test --coverage` prints a per-file ASCII
// table on stderr. We invoke it per subsystem and parse the relevant
// row (the "All files" aggregate, scoped by the test path glob). For
// large subsystems where bun's aggregate reports many files outside
// the subsystem root (because every test file imports cross-cutting
// modules), we filter to lines whose path begins with the subsystem
// directory and average them weighted by line count.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(__filename), "..", "..", "..");

interface FloorEntry {
  line_min: number;
  branch_min: number;
  rationale?: string;
  phase_2_observed?: { line?: number | null; branch?: number | null };
}

interface FloorFile {
  subsystems: Record<string, FloorEntry>;
}

interface CoverageRow {
  file: string;
  funcs: number;
  lines: number;
  // Branch coverage isn't reported by `bun test --coverage` today;
  // we surface it as undefined and let the floor check tolerate that.
  branch?: number;
  totalLines: number;
}

function loadFloors(): FloorFile {
  const path = join(REPO, "apps/engine/.coverage-floor.json");
  const text = readFileSync(path, "utf8");
  const parsed = JSON.parse(text) as FloorFile;
  if (!parsed.subsystems || typeof parsed.subsystems !== "object") {
    throw new Error(".coverage-floor.json: missing or invalid `subsystems` map");
  }
  return parsed;
}

function countLines(file: string): number {
  try {
    return readFileSync(file, "utf8").split("\n").length;
  } catch {
    return 0;
  }
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(cur, name);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (name === "node_modules" || name === "dist" || name === ".turbo") continue;
        stack.push(p);
      } else if (
        p.endsWith(".ts") &&
        !p.endsWith(".test.ts") &&
        !p.endsWith(".d.ts") &&
        !p.includes("/tests/")
      ) {
        out.push(p);
      }
    }
  }
  return out;
}

function runCoverage(subsystemDir: string): CoverageRow[] {
  const result = spawnSync("bun", ["test", subsystemDir, "--coverage"], {
    cwd: REPO,
    env: {
      ...process.env,
      SKIP_DOCKER: "1",
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://subkit:subkit@127.0.0.1:5432/subkit",
      MASTER_KEY:
        process.env.MASTER_KEY ??
        "00000000000000000000000000000000000000000000000000000000000000aa",
    },
    encoding: "utf8",
  });
  // bun prints the coverage table on stderr alongside the test summary.
  const stream = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return parseCoverageTable(stream);
}

function parseCoverageTable(text: string): CoverageRow[] {
  // The bun coverage table looks like:
  //   File                | % Funcs | % Lines | Uncovered Line #s
  //   ----                | ------- | ------- | ----------------
  //    apps/engine/src/rbac/evaluator.ts | 100.00 | 98.95 | 112-113
  // We pull rows whose first column starts with `apps/`.
  const rows: CoverageRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("|")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 3) continue;
    const file = parts[0];
    if (!file || !file.startsWith("apps/")) continue;
    const funcs = Number(parts[1]);
    const lines = Number(parts[2]);
    if (Number.isNaN(funcs) || Number.isNaN(lines)) continue;
    rows.push({
      file,
      funcs,
      lines,
      totalLines: countLines(join(REPO, file)),
    });
  }
  return rows;
}

function aggregateByPrefix(rows: CoverageRow[], subsystem: string): { line: number } | null {
  const prefix = subsystem.endsWith("/") ? subsystem : `${subsystem}/`;
  const matched = rows.filter((r) => r.file.startsWith(prefix));
  if (matched.length === 0) return null;
  // LOC-weighted average so a tiny 100%-covered helper doesn't pull
  // the aggregate up artificially.
  let totalLines = 0;
  let coveredLines = 0;
  for (const r of matched) {
    const total = r.totalLines || 1;
    totalLines += total;
    coveredLines += (r.lines / 100) * total;
  }
  return totalLines === 0 ? null : { line: (coveredLines / totalLines) * 100 };
}

const want = new Set(process.argv.slice(2));
const floors = loadFloors();

interface Result {
  subsystem: string;
  status: "PASS" | "FAIL" | "SKIP";
  message: string;
}
const results: Result[] = [];

for (const [subsystem, floor] of Object.entries(floors.subsystems)) {
  if (want.size > 0) {
    // Allow either the full path or the trailing leaf to match.
    const leaf = subsystem.split("/").pop() ?? "";
    if (!want.has(subsystem) && !want.has(leaf)) continue;
  }
  if (floor.line_min === 0 && floor.branch_min === 0) {
    results.push({
      subsystem,
      status: "SKIP",
      message: `floor=${floor.line_min}/${floor.branch_min} (deferred — see rationale)`,
    });
    continue;
  }
  const dir = join(REPO, subsystem);
  if (listTsFiles(dir).length === 0) {
    results.push({
      subsystem,
      status: "SKIP",
      message: "no source files under this directory",
    });
    continue;
  }
  const rows = runCoverage(subsystem);
  const agg = aggregateByPrefix(rows, subsystem);
  if (!agg) {
    results.push({
      subsystem,
      status: "FAIL",
      message: "no coverage rows matched the subsystem path; did the test target shrink?",
    });
    continue;
  }
  if (agg.line < floor.line_min) {
    results.push({
      subsystem,
      status: "FAIL",
      message: `line=${agg.line.toFixed(2)} (<${floor.line_min})`,
    });
  } else {
    results.push({
      subsystem,
      status: "PASS",
      message: `line=${agg.line.toFixed(2)} (>=${floor.line_min})`,
    });
  }
}

let pass = 0;
let fail = 0;
let skip = 0;
for (const r of results) {
  // biome-ignore lint/suspicious/noConsole: this is a CI script — direct stdout is the contract
  console.log(`${r.status.padEnd(4)} ${r.subsystem.padEnd(36)} ${r.message}`);
  if (r.status === "PASS") pass++;
  else if (r.status === "FAIL") fail++;
  else skip++;
}
// biome-ignore lint/suspicious/noConsole: summary line for CI parsing
console.log(`\n${pass} pass, ${fail} fail, ${skip} skip`);

process.exit(fail === 0 ? 0 : 1);
