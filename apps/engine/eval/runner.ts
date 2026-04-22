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
  /**
   * Category label. Includes the LLM flow names (`generate`, `extract`,
   * `repair`, `converse`, `discover`, `summarize`) and `infra` for
   * non-LLM integration tests (execution-engine behavior, cascade, etc.).
   */
  flow: "generate" | "extract" | "repair" | "converse" | "discover" | "summarize" | "infra";
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
  /**
   * Aggregate metrics across every fixture: per-flow pass rate + latency
   * percentiles so a single report is enough to spot a regression without
   * scrolling.
   */
  aggregates: {
    pass_rate: number;
    latency_ms: { p50: number; p95: number; max: number };
    per_flow: Record<
      string,
      {
        total: number;
        passed: number;
        failed: number;
        p50_ms: number;
        p95_ms: number;
      }
    >;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx] ?? 0;
}

function computeAggregates(items: RunReport["items"]): RunReport["aggregates"] {
  const latencies = items.map((i) => i.duration_ms).sort((a, b) => a - b);
  const per_flow: RunReport["aggregates"]["per_flow"] = {};
  for (const item of items) {
    const bucket = per_flow[item.flow] ?? { total: 0, passed: 0, failed: 0, p50_ms: 0, p95_ms: 0 };
    bucket.total += 1;
    if (item.pass) bucket.passed += 1;
    else bucket.failed += 1;
    per_flow[item.flow] = bucket;
  }
  for (const flow of Object.keys(per_flow)) {
    const flow_latencies = items
      .filter((i) => i.flow === flow)
      .map((i) => i.duration_ms)
      .sort((a, b) => a - b);
    per_flow[flow]!.p50_ms = percentile(flow_latencies, 50);
    per_flow[flow]!.p95_ms = percentile(flow_latencies, 95);
  }
  return {
    pass_rate: items.length === 0 ? 1 : items.filter((i) => i.pass).length / items.length,
    latency_ms: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.at(-1) ?? 0,
    },
    per_flow,
  };
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
    aggregates: computeAggregates(items),
  };
  writeCsv(report);
  writeJson(report);
  console.log(`\nTotal: ${fixtures.length}   Pass: ${passed}   Fail: ${failed}`);
  console.log(
    `Latency: p50=${report.aggregates.latency_ms.p50}ms  p95=${report.aggregates.latency_ms.p95}ms  max=${report.aggregates.latency_ms.max}ms`,
  );
  for (const [flow, agg] of Object.entries(report.aggregates.per_flow)) {
    console.log(
      `  ${flow}: ${agg.passed}/${agg.total} pass  p50=${agg.p50_ms}ms  p95=${agg.p95_ms}ms`,
    );
  }
  process.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
