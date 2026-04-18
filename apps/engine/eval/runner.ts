// Pre-deploy evaluation runner.
//
// Loads every fixture under `eval/fixtures/*.json`, dispatches it to
// the matching validator under `eval/validators/*.ts`, and emits a
// CSV + JSON report. Used by `/verify` as a gate so skill regressions
// are caught before they ship.
//
// Usage:
//   bun run apps/engine/eval/runner.ts
//
// Exit codes:
//   0 — all fixtures passed
//   1 — one or more fixtures failed (diagnostics on stderr)

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type ValidatorFn = (fixture: FixtureRecord) => Promise<ValidationResult> | ValidationResult;

export interface FixtureRecord {
  name: string;
  description?: string;
  flow: "generate" | "extract" | "repair" | "converse" | "discover";
  /** Arbitrary input payload handed to the validator. */
  input: unknown;
  /** Optional expected output payload the validator may assert against. */
  expected?: unknown;
}

export interface ValidationResult {
  pass: boolean;
  /** Short human-readable reason; surfaced in the CSV report. */
  reason?: string;
  metrics?: Record<string, number>;
}

export interface RunReport {
  started_at: string;
  finished_at: string;
  total: number;
  passed: number;
  failed: number;
  items: Array<{
    name: string;
    flow: string;
    pass: boolean;
    reason?: string;
    duration_ms: number;
    metrics?: Record<string, number>;
  }>;
}

const EVAL_DIR = join(process.cwd(), "apps/engine/eval");
const FIXTURES_DIR = join(EVAL_DIR, "fixtures");
const VALIDATORS_DIR = join(EVAL_DIR, "validators");
const OUT_DIR = join(EVAL_DIR, "out");

function loadFixtures(): FixtureRecord[] {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const raw = readFileSync(join(FIXTURES_DIR, f), "utf8");
    const rec = JSON.parse(raw) as FixtureRecord;
    if (!rec.name) rec.name = f.replace(/\.json$/, "");
    return rec;
  });
}

async function loadValidator(name: string): Promise<ValidatorFn | undefined> {
  const candidatePaths = [join(VALIDATORS_DIR, `${name}.ts`), join(VALIDATORS_DIR, `${name}.js`)];
  for (const path of candidatePaths) {
    try {
      const mod = await import(path);
      const fn = (mod.validate ?? mod.default) as ValidatorFn | undefined;
      if (fn) return fn;
    } catch {
      // Try next path.
    }
  }
  return undefined;
}

async function runOne(rec: FixtureRecord): Promise<{
  result: ValidationResult;
  duration_ms: number;
}> {
  const start = Date.now();
  try {
    const validator = await loadValidator(rec.name);
    if (!validator) {
      return {
        result: { pass: false, reason: `no validator matching ${rec.name}` },
        duration_ms: Date.now() - start,
      };
    }
    const result = await validator(rec);
    return { result, duration_ms: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      result: { pass: false, reason: `validator threw: ${msg}` },
      duration_ms: Date.now() - start,
    };
  }
}

function writeCsv(report: RunReport): void {
  const lines = ["name,flow,pass,duration_ms,reason"];
  for (const item of report.items) {
    lines.push(
      [
        item.name,
        item.flow,
        item.pass ? "pass" : "fail",
        String(item.duration_ms),
        JSON.stringify(item.reason ?? ""),
      ].join(","),
    );
  }
  writeFileSync(join(OUT_DIR, "eval-report.csv"), lines.join("\n"), "utf8");
}

function writeJson(report: RunReport): void {
  writeFileSync(join(OUT_DIR, "eval-report.json"), JSON.stringify(report, null, 2), "utf8");
}

async function main(): Promise<void> {
  try {
    require("node:fs").mkdirSync(OUT_DIR, { recursive: true });
  } catch {
    // ignore
  }
  const fixtures = loadFixtures();
  const items: RunReport["items"] = [];
  let passed = 0;
  let failed = 0;
  for (const rec of fixtures) {
    const { result, duration_ms } = await runOne(rec);
    const item = {
      name: rec.name,
      flow: rec.flow,
      pass: result.pass,
      duration_ms,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.metrics !== undefined ? { metrics: result.metrics } : {}),
    };
    items.push(item);
    if (result.pass) {
      passed += 1;
      console.log(`PASS  ${rec.name}  (${duration_ms}ms)`);
    } else {
      failed += 1;
      console.log(`FAIL  ${rec.name}  ${result.reason ?? ""}`);
    }
  }
  const report: RunReport = {
    started_at: new Date(Date.now() - 1).toISOString(),
    finished_at: new Date().toISOString(),
    total: fixtures.length,
    passed,
    failed,
    items,
  };
  writeCsv(report);
  writeJson(report);
  console.log(`\nTotal: ${fixtures.length}   Pass: ${passed}   Fail: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
