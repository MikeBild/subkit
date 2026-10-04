#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(__filename), "..", "..", "..");

interface FloorEntry {
  line_min: number;
  branch_min: number;
  rationale?: string;
  observed?: { line?: number | null; branch?: number | null };
}

interface FloorFile {
  subsystems: Record<string, FloorEntry>;
}

interface CoverageRow {
  file: string;
  funcs: number;
  lines: number;
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
    maxBuffer: 64 * 1024 * 1024,
  });
  const stream = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return parseCoverageTable(stream);
}

function parseCoverageTable(text: string): CoverageRow[] {
  const rows: CoverageRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("|")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 3) continue;
    const file = parts[0];
    if (!file?.startsWith("apps/")) continue;
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
  console.log(`${r.status.padEnd(4)} ${r.subsystem.padEnd(36)} ${r.message}`);
  if (r.status === "PASS") pass++;
  else if (r.status === "FAIL") fail++;
  else skip++;
}
console.log(`\n${pass} pass, ${fail} fail, ${skip} skip`);

process.exit(fail === 0 ? 0 : 1);
