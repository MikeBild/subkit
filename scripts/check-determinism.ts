#!/usr/bin/env bun
// Determinism lint. Blocks banned patterns in test files so test
// determinism doesn't decay PR-by-PR.
//
// Rules:
//   1. `setTimeout(` inside *.test.ts / *.test.tsx / *.journey.test.ts
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
//   0  — clean
//   1  — rule violation (fail CI)
//
// Usage:
//   bun run scripts/check-determinism.ts
//   SUBKIT_DETERMINISM_WARN=1 bun run scripts/check-determinism.ts
//     (downgrade all violations to warnings — for incremental adoption)

import { readFileSync } from "node:fs";
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

// Files exempt from the setTimeout block because they implement the
// helper that the rule points callers to.
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
    pattern: /\bnew\s+Date\s*\(/,
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
  // Check the current line and up to 3 lines above (covers multi-line
  // comments where the marker sits 2-3 lines before the offending call).
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
    // Skip pure-comment lines.
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

async function main(): Promise<number> {
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

  if (!warnOnly && errors.length > 0) return 1;
  return 0;
}

const code = await main();
process.exit(code);
