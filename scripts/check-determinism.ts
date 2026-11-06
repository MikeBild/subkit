#!/usr/bin/env bun

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";

export interface Violation {
  file: string;
  line: number;
  col: number;
  rule: string;
  severity: "error" | "warn";
  snippet: string;
  reason: string;
}

const ROOT = resolve(import.meta.dir, "..");

const TEST_GLOBS = [
  "apps/**/src/**/*.test.ts",
  "apps/**/src/**/*.test.tsx",
  "apps/**/src/**/*.journey.test.ts",
  "tests/**/*.test.ts",
  "tests/**/*.test.tsx",
  "packages/**/src/**/*.test.ts",
  "packages/**/src/**/*.test.tsx",
];

const SLEEP_WHITELIST = new Set(["apps/engine/src/test-helpers/determinism/wait.ts"]);

interface Rule {
  name: string;
  pattern: RegExp;
  severity: "error" | "warn";
  reason: string;
  allowWallClock?: boolean;
  allowRandom?: boolean;
}

const RULES: Rule[] = [
  {
    name: "no-setTimeout-in-tests",
    pattern: /\bsetTimeout\s*\(/,
    severity: "error",
    reason:
      "Use waitFor / flush from test-helpers/determinism; wall-clock sleeps are flake sources.",
    allowWallClock: true,
  },
  {
    name: "no-math-random-in-tests",
    pattern: /\bMath\.random\s*\(/,
    severity: "error",
    reason: "Use createSeededRandom from test-helpers/determinism.",
    allowRandom: true,
  },
  {
    name: "no-random-uuid-in-tests",
    pattern: /\brandomUUID\s*\(/,
    severity: "error",
    reason: "Use createDeterministicUuidFactory from test-helpers/determinism/ids.",
    allowRandom: true,
  },
  {
    name: "no-random-bytes-in-tests",
    pattern: /\brandomBytes\s*\(/,
    severity: "error",
    reason: "Use createDeterministicHexFactory from test-helpers/determinism/ids.",
    allowRandom: true,
  },
  {
    name: "no-date-now-in-tests",
    pattern: /\bDate\.now\s*\(/,
    severity: "warn",
    reason:
      "Prefer getTestNow / FROZEN_NOW from test-helpers/determinism/clock for reproducible timestamps.",
    allowWallClock: true,
  },
  {
    name: "no-new-date-in-tests",
    pattern: /\bnew\s+Date\s*\(\s*\)/,
    severity: "warn",
    reason: "Prefer getTestNow / FROZEN_NOW from test-helpers/determinism/clock.",
    allowWallClock: true,
  },
  {
    name: "no-only-in-tests",
    pattern: /\b(?:test|describe|it)\.only\s*\(/,
    severity: "error",
    reason: "Remove `.only(...)` before committing — it masks the rest of the suite.",
  },
  {
    name: "no-skip-in-tests",
    pattern: /\b(?:test|describe|it)\.skip\s*\(/,
    severity: "error",
    reason:
      "Do not commit `.skip(...)`. Use `.skipIf(condition)` with a named env flag if the skip is environmental.",
  },
];

function hasMarker(lines: string[], index: number, marker: string): boolean {
  for (let k = index; k >= Math.max(0, index - 3); k--) {
    if ((lines[k] ?? "").includes(marker)) return true;
  }
  return false;
}

async function listTestFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const pattern of TEST_GLOBS) {
    const glob = new Glob(pattern);
    for await (const f of glob.scan({ cwd: ROOT, absolute: false, onlyFiles: true })) {
      out.push(f);
    }
  }
  return [...new Set(out)].sort();
}

const PROPERTY_RUN = /\bfc\.(?:assert|check)\s*\(/g;
const UNSEEDED_SOURCE = /\b(?:Date\.now|Math\.random|performance\.now)\b|\bnew\s+Date\s*\(/;

function callArguments(src: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = open + 1;
  for (let k = open; k < src.length; k++) {
    const ch = src[k] as string;
    if (quote) {
      if (ch === "\\") k++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      depth--;
      if (depth === 0) {
        args.push(src.slice(start, k));
        return args;
      }
    } else if (ch === "," && depth === 1) {
      args.push(src.slice(start, k));
      start = k + 1;
    }
  }
  args.push(src.slice(start));
  return args;
}

function hasFixedSeed(text: string): boolean {
  const seed = /\bseed\s*:\s*([^,}\n]+)/.exec(text);
  return seed !== null && !UNSEEDED_SOURCE.test(seed[1] ?? "");
}

function referencesName(text: string, name: string): boolean {
  let from = text.indexOf(name);
  while (from !== -1) {
    const before = text[from - 1] ?? " ";
    const after = text[from + name.length] ?? " ";
    const spread = text.slice(Math.max(0, from - 3), from) === "...";
    if ((spread || !/[\w$.]/.test(before)) && !/[\w$]/.test(after)) return true;
    from = text.indexOf(name, from + 1);
  }
  return false;
}

function seededConstants(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    for (let k = open; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}" && --depth === 0) {
        if (hasFixedSeed(src.slice(open, k + 1))) out.add(m[1] as string);
        break;
      }
    }
  }
  return out;
}

export function propertySeedViolations(relPath: string, src: string): Violation[] {
  const violations: Violation[] = [];
  const lines = src.split("\n");
  const seeded = [...seededConstants(src)];
  for (const m of src.matchAll(PROPERTY_RUN)) {
    const lineIndex = src.slice(0, m.index).split("\n").length - 1;
    const line = lines[lineIndex] ?? "";
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
    const options = callArguments(src, (m.index ?? 0) + m[0].length - 1)
      .slice(1)
      .join(",");
    const code = options.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
    if (hasFixedSeed(code)) continue;
    if (seeded.some((name) => referencesName(code, name))) continue;
    violations.push({
      file: relPath,
      line: lineIndex + 1,
      col: line.indexOf("fc.") + 1,
      rule: "fc-assert-requires-seed",
      severity: "error",
      snippet: line.trim(),
      reason:
        "Pass a fixed seed to every fast-check run: fc.assert(fc.property(...), { seed: 20261106, numRuns: 200 }).",
    });
  }
  return violations;
}

export function checkSource(relPath: string, src: string): Violation[] {
  const lines = src.split("\n");
  const violations: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
    for (const rule of RULES) {
      const m = rule.pattern.exec(line);
      if (!m) continue;
      if (rule.allowWallClock && hasMarker(lines, i, "allow-wall-clock")) continue;
      if (rule.allowRandom && hasMarker(lines, i, "allow-random")) continue;
      violations.push({
        file: relPath,
        line: i + 1,
        col: (m.index ?? 0) + 1,
        rule: rule.name,
        severity: rule.severity,
        snippet: line.trim(),
        reason: rule.reason,
      });
    }
  }
  violations.push(...propertySeedViolations(relPath, src));
  return violations.sort((x, y) => x.line - y.line || x.col - y.col);
}

function checkFile(relPath: string): Violation[] {
  if (SLEEP_WHITELIST.has(relPath)) return [];
  return checkSource(relPath, readFileSync(resolve(ROOT, relPath), "utf8"));
}

const BASELINE_PATH = resolve(ROOT, "scripts/determinism.baseline.json");

function loadBaseline(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function writeBaseline(counts: Record<string, number>): void {
  const sorted = Object.fromEntries(
    Object.entries(counts)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
}

function countWarningsByFile(violations: Violation[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of violations) {
    if (v.severity !== "warn") continue;
    out[v.file] = (out[v.file] ?? 0) + 1;
  }
  return out;
}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));
  const updateBaseline = args.has("--update-baseline");

  const files = await listTestFiles();
  const all: Violation[] = [];
  for (const f of files) all.push(...checkFile(f));

  const warnOnly = process.env.SUBKIT_DETERMINISM_WARN === "1";
  const errors = all.filter((v) => v.severity === "error");
  const warnings = all.filter((v) => v.severity === "warn");

  for (const v of all) {
    const tag = v.severity === "error" && !warnOnly ? "error" : "warn";
    const level = `${tag}[${v.rule}]`;
    console.log(`${v.file}:${v.line}:${v.col} ${level} — ${v.snippet}`);
    console.log(`  reason: ${v.reason}`);
  }

  console.log("");
  console.log(`determinism lint: ${files.length} files scanned`);
  console.log(`  errors:   ${errors.length}`);
  console.log(`  warnings: ${warnings.length}`);

  const current = countWarningsByFile(all);
  if (updateBaseline) {
    writeBaseline(current);
    console.log(`baseline updated: ${BASELINE_PATH}`);
    return 0;
  }

  let baselineRegressions = 0;
  let aggregateRegression = 0;
  if (!warnOnly) {
    const baseline = loadBaseline();
    const seenFiles = new Set([...Object.keys(baseline), ...Object.keys(current)]);
    const regressions: string[] = [];
    const improvements: string[] = [];
    for (const f of seenFiles) {
      const before = baseline[f] ?? 0;
      const after = current[f] ?? 0;
      if (after > before) {
        regressions.push(`  ${f}: ${before} → ${after} warning(s)`);
        baselineRegressions += after - before;
      } else if (after < before) {
        improvements.push(`  ${f}: ${before} → ${after} warning(s)`);
      }
    }

    const totalCurrent = Object.values(current).reduce((a, b) => a + b, 0);
    const totalBaseline = Object.values(baseline).reduce((a, b) => a + b, 0);
    if (totalCurrent > totalBaseline) {
      aggregateRegression = totalCurrent - totalBaseline;
    }
    const aggregateLine = `aggregate: ${totalBaseline} → ${totalCurrent} warning(s) across ${Object.keys(current).length} file(s)`;

    if (improvements.length > 0) {
      console.log("");
      console.log("baseline improvements (run with --update-baseline to lock in):");
      for (const line of improvements) console.log(line);
      if (totalCurrent < totalBaseline) {
        console.log(`  ${aggregateLine}`);
      }
    }
    if (regressions.length > 0 || aggregateRegression > 0) {
      console.log("");
      console.log("baseline regressions (new warnings vs. tolerated baseline):");
      for (const line of regressions) console.log(line);
      if (aggregateRegression > 0) {
        console.log(`  ${aggregateLine} — aggregate growth blocked`);
      }
    }

    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      const direction =
        totalCurrent < totalBaseline ? "↓" : totalCurrent > totalBaseline ? "↑" : "=";
      const lines = ["## determinism baseline", "", `${direction} ${aggregateLine}`, ""];
      if (improvements.length > 0) {
        lines.push("### improvements", "", ...improvements.map((l) => `-${l}`), "");
      }
      if (regressions.length > 0) {
        lines.push("### regressions", "", ...regressions.map((l) => `-${l}`), "");
      }
      try {
        appendFileSync(summaryPath, `${lines.join("\n")}\n`);
      } catch {}
    }
  }

  if (!warnOnly && errors.length > 0) return 1;
  if (!warnOnly && baselineRegressions > 0) return 1;
  if (!warnOnly && aggregateRegression > 0) return 1;
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
