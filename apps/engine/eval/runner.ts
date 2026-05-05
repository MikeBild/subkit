// Pre-deploy evaluation runner.
//
// Loads every fixture under `eval/fixtures/*.json`, dispatches it to
// the matching validator under `eval/validators/*.ts`, and emits a
// CSV + JSON report. Used by `bun run verify:ai` and the full
// `bun run verify` gate so authoring-contract regressions are caught
// before they ship.
//
// Usage:
//   bun run apps/engine/eval/runner.ts
//
// Exit codes:
//   0 — all fixtures passed
//   1 — one or more fixtures failed (diagnostics on stderr)

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invokeJudge, shouldInvokeJudge } from "./llm-judge.ts";

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

/** Outcome verdict from the optional LLM judge. The judge enriches a
 *  validator's result; it never overrides a deterministic `pass=false`.
 *  Only emitted when the validator returns `pass=false` AND
 *  `function_passed=true` (structurally fine but semantically dubious)
 *  AND `SUBKIT_EVAL_LLM_JUDGE=1`.
 *
 *    - `passes`  — judge agrees the output is acceptable
 *    - `partial` — judge sees something off but not a hard failure
 *    - `failed`  — judge agrees the output is wrong
 *
 *  These verdicts stream into the CSV/JSON report and surface in the
 *  failing-fixture diagnostics so a reviewer can read the LLM's
 *  reasoning alongside the validator's deterministic verdict. */
export type LlmJudgment = "passes" | "partial" | "failed";

export interface ValidationResult {
  /** Hard gate. The runner exits non-zero when any fixture has
   *  `pass = false`. Determinism contract: same seed → same value. */
  pass: boolean;
  /** Short human-readable reason; surfaced in the CSV report. */
  reason?: string;
  /** Result of the deterministic validator function. Defaults to
   *  `pass` when absent — most validators do not need to differentiate
   *  structural pass-through from semantic agreement. The split exists
   *  so the LLM judge can run only when the structure is intact but
   *  the semantics are uncertain. */
  function_passed?: boolean;
  /** Optional verdict from the LLM judge (see `LlmJudgment`). Always
   *  null when `SUBKIT_EVAL_LLM_JUDGE` is unset. */
  llm_judgment?: LlmJudgment;
  /** Human-readable reasoning the judge produced. */
  llm_reason?: string;
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
    function_passed?: boolean;
    llm_judgment?: LlmJudgment;
    llm_reason?: string;
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
  for (const [flow, bucket] of Object.entries(per_flow)) {
    const flow_latencies = items
      .filter((i) => i.flow === flow)
      .map((i) => i.duration_ms)
      .sort((a, b) => a - b);
    bucket.p50_ms = percentile(flow_latencies, 50);
    bucket.p95_ms = percentile(flow_latencies, 95);
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
const BASELINES_DIR = join(EVAL_DIR, "baselines");
/**
 * Maximum percentage-point drop in any single flow's pass rate before
 * the runner fails the gate. Conservative — anything past this is a
 * real regression, not eval noise. Raise the baseline (regenerate the
 * CSV) when a flow has improved permanently.
 */
const PASS_RATE_DRIFT_PCT_MAX = 10;

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
  const lines = ["name,flow,pass,function_passed,llm_judgment,duration_ms,reason,llm_reason"];
  for (const item of report.items) {
    const fnPassed = item.function_passed ?? item.pass;
    lines.push(
      [
        item.name,
        item.flow,
        item.pass ? "pass" : "fail",
        fnPassed ? "pass" : "fail",
        item.llm_judgment ?? "",
        String(item.duration_ms),
        JSON.stringify(item.reason ?? ""),
        JSON.stringify(item.llm_reason ?? ""),
      ].join(","),
    );
  }
  writeFileSync(join(OUT_DIR, "eval-report.csv"), lines.join("\n"), "utf8");
}

function writeJson(report: RunReport): void {
  writeFileSync(join(OUT_DIR, "eval-report.json"), JSON.stringify(report, null, 2), "utf8");
}

interface BaselineRow {
  flow: string;
  pass_rate: number;
}

/**
 * Load `baselines/per-flow-pass-rate.csv` if present and compare each
 * flow's current pass rate against the recorded baseline. Returns the
 * list of flows whose pass rate dropped by more than
 * `PASS_RATE_DRIFT_PCT_MAX` points — the runner exits non-zero when
 * non-empty. The first run (no baseline file) is silent so a fresh
 * checkout can produce its own snapshot via `bun run eval:baseline`.
 */
function compareAgainstBaseline(report: RunReport): {
  drift: Array<{ flow: string; baseline_pct: number; current_pct: number; drop_pp: number }>;
  baseline_present: boolean;
} {
  const baselinePath = join(BASELINES_DIR, "per-flow-pass-rate.csv");
  let raw: string;
  try {
    raw = readFileSync(baselinePath, "utf8");
  } catch {
    return { drift: [], baseline_present: false };
  }
  const rows: BaselineRow[] = [];
  for (const line of raw.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [flow, rateStr] = line.split(",");
    if (!flow || !rateStr) continue;
    const pass_rate = Number.parseFloat(rateStr);
    if (!Number.isFinite(pass_rate)) continue;
    rows.push({ flow: flow.trim(), pass_rate });
  }
  const drift: Array<{
    flow: string;
    baseline_pct: number;
    current_pct: number;
    drop_pp: number;
  }> = [];
  for (const baseline of rows) {
    const bucket = report.aggregates.per_flow[baseline.flow];
    if (!bucket || bucket.total === 0) continue;
    const current = bucket.passed / bucket.total;
    const dropPp = (baseline.pass_rate - current) * 100;
    if (dropPp > PASS_RATE_DRIFT_PCT_MAX) {
      drift.push({
        flow: baseline.flow,
        baseline_pct: Math.round(baseline.pass_rate * 1000) / 10,
        current_pct: Math.round(current * 1000) / 10,
        drop_pp: Math.round(dropPp * 10) / 10,
      });
    }
  }
  return { drift, baseline_present: true };
}

/**
 * Write the current per-flow pass rate as the new baseline. Invoked
 * via `--write-baseline` so an operator who has intentionally improved
 * a flow's pass rate can lock the new floor in one step. The CSV
 * shape is `flow,pass_rate` with `pass_rate` as a 0..1 fraction.
 */
function writeBaseline(report: RunReport): void {
  try {
    require("node:fs").mkdirSync(BASELINES_DIR, { recursive: true });
  } catch {
    // ignore
  }
  const lines = ["flow,pass_rate"];
  for (const [flow, bucket] of Object.entries(report.aggregates.per_flow)) {
    if (bucket.total === 0) continue;
    const rate = bucket.passed / bucket.total;
    lines.push(`${flow},${rate.toFixed(4)}`);
  }
  writeFileSync(join(BASELINES_DIR, "per-flow-pass-rate.csv"), `${lines.join("\n")}\n`, "utf8");
  console.log(`\nBaseline updated: ${join(BASELINES_DIR, "per-flow-pass-rate.csv")}`);
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
    // The judge harness is opt-in via `SUBKIT_EVAL_LLM_JUDGE`; until
    // wired to a real provider it is dormant. The runner still
    // consults `shouldInvokeJudge` so the contract is exercised in
    // tests that pass a custom provider.
    const judgeShould = shouldInvokeJudge({
      pass: result.pass,
      function_passed: result.function_passed ?? result.pass,
    });
    let llm_judgment: ValidationResult["llm_judgment"] | undefined;
    let llm_reason: ValidationResult["llm_reason"] | undefined;
    if (judgeShould) {
      try {
        const judged = await invokeJudge({
          fixture_name: rec.name,
          flow: rec.flow,
          input: rec.input,
          expected: rec.expected,
          observed: result,
          ...(result.reason !== undefined ? { validator_reason: result.reason } : {}),
        });
        llm_judgment = judged.judgment;
        llm_reason = judged.reason;
      } catch {
        // The default provider stub throws until a follow-up wires
        // `invoke()` through. Do not fail the eval gate on this — the
        // deterministic verdict still lands.
      }
    }
    const item = {
      name: rec.name,
      flow: rec.flow,
      pass: result.pass,
      duration_ms,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.metrics !== undefined ? { metrics: result.metrics } : {}),
      ...(result.function_passed !== undefined ? { function_passed: result.function_passed } : {}),
      ...(llm_judgment !== undefined ? { llm_judgment } : {}),
      ...(llm_reason !== undefined ? { llm_reason } : {}),
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
  // Baseline drift gate. Operators bless a new baseline by passing
  // `--write-baseline` after a deliberate improvement; without that
  // flag, a flow whose pass rate slipped >10 percentage points fails
  // the gate.
  if (process.argv.includes("--write-baseline")) {
    writeBaseline(report);
  } else {
    const { drift, baseline_present } = compareAgainstBaseline(report);
    if (!baseline_present) {
      console.log(
        "\n(no eval/baselines/per-flow-pass-rate.csv yet — run with --write-baseline to seed it)",
      );
    } else if (drift.length > 0) {
      console.error("\nFAIL: per-flow pass-rate drift exceeds gate:");
      for (const d of drift) {
        console.error(
          `  ${d.flow}: baseline ${d.baseline_pct}% → current ${d.current_pct}% (drop ${d.drop_pp}pp, gate ${PASS_RATE_DRIFT_PCT_MAX}pp)`,
        );
      }
      console.error(
        "Investigate the regression OR re-run with --write-baseline once the new floor is intentional.",
      );
      process.exit(1);
    } else {
      console.log("\nBaseline drift: within gate.");
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
