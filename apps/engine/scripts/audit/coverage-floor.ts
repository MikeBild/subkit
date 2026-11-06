import { basename, dirname, join } from "node:path/posix";
import { isCorePath } from "./rules.ts";

export interface FloorEntry {
  line_min: number;
  branch_min: number;
  rationale?: string;
  tests?: string[];
  observed?: { line?: number | null; branch?: number | null };
}

interface CoreDefault {
  line_min: number;
  branch_min: number;
  exclude: string[];
}

interface FloorFile {
  subsystems: Record<string, FloorEntry>;
  files: Record<string, FloorEntry>;
  core_default: CoreDefault | null;
}

export interface CoverageRow {
  file: string;
  funcs: number;
  lines: number;
}

const isFloor = (entry: unknown): entry is FloorEntry =>
  typeof entry === "object" &&
  entry !== null &&
  typeof (entry as FloorEntry).line_min === "number" &&
  typeof (entry as FloorEntry).branch_min === "number" &&
  ((entry as FloorEntry).tests === undefined ||
    (Array.isArray((entry as FloorEntry).tests) &&
      ((entry as FloorEntry).tests as unknown[]).every((t) => typeof t === "string")));

export function parseFloorFile(raw: unknown): { floors: FloorFile } | { errors: string[] } {
  const errors: string[] = [];
  const root = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const section = (key: "subsystems" | "files"): Record<string, FloorEntry> => {
    const value = root[key];
    if (value === undefined) return {};
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`\`${key}\` must be an object`);
      return {};
    }
    const out: Record<string, FloorEntry> = {};
    for (const [name, entry] of Object.entries(value)) {
      if (isFloor(entry)) out[name] = entry;
      else errors.push(`${key}.${name}: needs numeric line_min and branch_min (tests: string[])`);
    }
    return out;
  };
  const subsystems = section("subsystems");
  const files = section("files");
  let coreDefault: CoreDefault | null = null;
  const rawDefault = root.core_default;
  if (rawDefault !== undefined) {
    const d = rawDefault as Partial<CoreDefault>;
    if (
      isFloor(rawDefault) &&
      (d.exclude === undefined ||
        (Array.isArray(d.exclude) && d.exclude.every((p) => typeof p === "string")))
    ) {
      coreDefault = {
        line_min: d.line_min as number,
        branch_min: d.branch_min as number,
        exclude: d.exclude ?? [],
      };
    } else {
      errors.push("core_default: needs numeric line_min and branch_min (exclude: string[])");
    }
  }
  if (Object.keys(subsystems).length === 0 && Object.keys(files).length === 0 && !errors.length) {
    errors.push("no subsystems or files declared");
  }
  if (errors.length > 0) return { errors };
  return { floors: { subsystems, files, core_default: coreDefault } };
}

export function resolveFileFloors(
  floors: FloorFile,
  sourceFiles: readonly string[],
): Map<string, FloorEntry> {
  const out = new Map<string, FloorEntry>();
  const d = floors.core_default;
  if (d) {
    for (const file of sourceFiles) {
      if (!isCorePath(file) || d.exclude.some((prefix) => file.startsWith(prefix))) continue;
      out.set(file, {
        line_min: d.line_min,
        branch_min: d.branch_min,
        rationale: "core_default",
      });
    }
  }
  for (const [file, entry] of Object.entries(floors.files)) out.set(file, entry);
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function testCandidates(file: string): string[] {
  const dir = dirname(file);
  const stem = basename(file).replace(/\.tsx?$/, "");
  return [
    join(dir, `${stem}.test.ts`),
    join(dir, `${stem}.test.tsx`),
    join(dir, "__tests__", `${stem}.test.ts`),
    join(dir, "tests", `${stem}.test.ts`),
  ];
}

export function parseCoverageTable(text: string): CoverageRow[] {
  const rows: CoverageRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("|")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 3) continue;
    const file = parts[0] ?? "";
    if (!file.startsWith("apps/") && !file.startsWith("packages/")) continue;
    const funcs = Number(parts[1]);
    const lines = Number(parts[2]);
    if (Number.isNaN(funcs) || Number.isNaN(lines)) continue;
    rows.push({ file, funcs, lines });
  }
  return rows;
}

export function aggregateByPrefix(
  rows: readonly CoverageRow[],
  prefix: string,
  totalLinesOf: (file: string) => number,
): number | null {
  const dir = prefix.endsWith("/") ? prefix : `${prefix}/`;
  let total = 0;
  let covered = 0;
  for (const row of rows) {
    if (!row.file.startsWith(dir)) continue;
    const lines = totalLinesOf(row.file) || 1;
    total += lines;
    covered += (row.lines / 100) * lines;
  }
  return total === 0 ? null : (covered / total) * 100;
}

interface FloorVerdict {
  status: "PASS" | "FAIL";
  message: string;
}

export function judgeFile(
  file: string,
  floor: FloorEntry,
  rows: readonly CoverageRow[],
): FloorVerdict {
  const row = rows.find((r) => r.file === file);
  if (!row) {
    return { status: "FAIL", message: "file missing from the coverage table; no test loads it" };
  }
  const branch = `branch=unmeasured (bun reports no branch coverage; floor ${floor.branch_min})`;
  if (row.lines < floor.line_min) {
    return {
      status: "FAIL",
      message: `line=${row.lines.toFixed(2)} (<${floor.line_min}) funcs=${row.funcs.toFixed(2)} ${branch}`,
    };
  }
  return {
    status: "PASS",
    message: `line=${row.lines.toFixed(2)} (>=${floor.line_min}) funcs=${row.funcs.toFixed(2)} ${branch}`,
  };
}
