#!/usr/bin/env bun
//      → block. Whitelisted via a trailing `// allow-wall-clock` comment
//      on (or immediately above) the offending line.
//   2. `Math.random()`, `randomUUID(`, `randomBytes(` in test files →
//      block. Use seeded factories from `test-helpers/determinism`.
//   3. `.only(` / `.skip(` / `test.only(` / `describe.only(` /
//      `describe.skip(` → block. Intentional skips must be gated by
//      `.skipIf` with an env condition.
//   4. `Date.now()` / `new Date()` in test files → warn. Allowed with
//      a trailing `// allow-wall-clock` comment.
//
// Exit codes:
//   0  — clean (or improvement vs baseline)
//   1  — rule violation, or warning regression vs baseline (fail CI)
//
// Usage:
//   bun run scripts/check-determinism.ts
//   bun run scripts/check-determinism.ts --update-baseline
//     (regenerate the warning baseline after a cleanup)
//   SUBKIT_DETERMINISM_WARN=1 bun run scripts/check-determinism.ts
//     (downgrade error-level violations to warnings — for incremental adoption)
//
// Baseline ratchet:
//   `scripts/determinism.baseline.json` maps test file → tolerated warning
//   count. Existing warnings stay tolerated; any new warning in any file
//   (or a brand new file with any warnings) fails CI. Decreasing counts
//   are rewarded — the run prints which files improved and exits 0; run
//   `--update-baseline` to lock the improvement in.
//
//   The baseline was drained from 53 files / 56 tolerated warnings to
//   {}. A regression that re-introduces 30+ warnings is a real regression,
//   not a fresh "0 → 30" shock — read the file's git log if a sudden
//   spike surprises you (`git log scripts/determinism.baseline.json`).
//   The aggregate-sum check below blocks any net growth from {}, so a
//   single warning failing CI is the intended ratchet behaviour, not
//   a lost-context surprise.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";

interface Violation {
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
  /** Allow with a `// allow-wall-clock` on the same or previous line. */
  allowWallClock?: boolean;
  /** Allow with a `// allow-random` on the same or previous line. */
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

function checkFile(relPath: string): Violation[] {
  if (SLEEP_WHITELIST.has(relPath)) return [];
  const abs = resolve(ROOT, relPath);
  const src = readFileSync(abs, "utf8");
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
  return violations;
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

const code = await main();
process.exit(code);
