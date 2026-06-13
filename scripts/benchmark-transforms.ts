#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { evaluate as evaluateJsonata } from "../apps/engine/src/execution/jsonata-engine.ts";
import { runJs } from "../apps/engine/src/sandboxes/quickjs/runtime.ts";

interface BenchRow {
  name: string;
  iterations: number;
  total_ms: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
}

interface BenchReport {
  started_at: string;
  finished_at: string;
  iterations: number;
  benchmarks: BenchRow[];
}

interface CliArgs {
  iterations: number;
  out: string;
  baseline: string | null;
}

const DEFAULT_OUT = join(process.cwd(), "apps/engine/eval/out/transform-benchmark.json");

function parseArgs(argv: string[]): CliArgs {
  let iterations = 100;
  let out = DEFAULT_OUT;
  let baseline: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`missing value for ${arg}`);
      i += 1;
      return v;
    };
    if (arg === "--iterations") iterations = Number.parseInt(next(), 10);
    else if (arg === "--out") out = next();
    else if (arg === "--baseline") baseline = next();
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run scripts/benchmark-transforms.ts [--iterations 100] [--out report.json] [--baseline report.json]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("--iterations must be a positive integer");
  }
  return { iterations, out, baseline };
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
  return sorted[idx] ?? 0;
}

async function bench(
  name: string,
  iterations: number,
  fn: () => Promise<unknown>,
): Promise<BenchRow> {
  const samples: number[] = [];
  await fn();
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, n) => sum + n, 0);
  return {
    name,
    iterations,
    total_ms: Number(total.toFixed(3)),
    avg_ms: Number((total / iterations).toFixed(3)),
    p50_ms: Number(percentile(sorted, 0.5).toFixed(3)),
    p95_ms: Number(percentile(sorted, 0.95).toFixed(3)),
    max_ms: Number((sorted[sorted.length - 1] ?? 0).toFixed(3)),
  };
}

function compareBaseline(baseline: BenchReport, current: BenchReport): string[] {
  const currentByName = new Map(current.benchmarks.map((row) => [row.name, row]));
  const changes: string[] = [];
  for (const base of baseline.benchmarks) {
    const cur = currentByName.get(base.name);
    if (!cur) {
      changes.push(`REGRESSION ${base.name}: missing current benchmark`);
      continue;
    }
    if (base.p95_ms > 0 && cur.p95_ms > base.p95_ms * 1.25) {
      changes.push(`REGRESSION ${base.name}: p95 ${base.p95_ms}ms -> ${cur.p95_ms}ms`);
    }
    if (base.avg_ms > 0 && cur.avg_ms > base.avg_ms * 1.25) {
      changes.push(`REGRESSION ${base.name}: avg ${base.avg_ms}ms -> ${cur.avg_ms}ms`);
    }
  }
  return changes;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scope = {
    a: { data: { n: 21, text: "München 😀", rows: Array.from({ length: 25 }, (_, n) => ({ n })) } },
  };
  const input = { multiplier: 2 };
  const started_at = new Date().toISOString();
  const benchmarks = [
    await bench("quickjs-arithmetic", args.iterations, () =>
      runJs({
        code: "return input.scope.a.data.n * input.input.multiplier;",
        input: { scope, input },
      }),
    ),
    await bench("jsonata-arithmetic", args.iterations, () =>
      evaluateJsonata("$scope.a.data.n * $input.multiplier", scope, { scope, input }),
    ),
    await bench("quickjs-base64-jsonata-compatible", args.iterations, () =>
      runJs({
        code: "return sk.base64Encode(input.scope.a.data.text);",
        input: { scope, input },
      }),
    ),
    await bench("quickjs-base64-utf8", args.iterations, () =>
      runJs({
        code: "return sk.base64EncodeUtf8(input.scope.a.data.text);",
        input: { scope, input },
      }),
    ),
  ];
  const report: BenchReport = {
    started_at,
    finished_at: new Date().toISOString(),
    iterations: args.iterations,
    benchmarks,
  };
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  for (const row of benchmarks) {
    console.log(
      `${row.name}: avg=${row.avg_ms}ms p50=${row.p50_ms}ms p95=${row.p95_ms}ms max=${row.max_ms}ms`,
    );
  }
  console.log(`report: ${args.out}`);
  if (args.baseline) {
    const baseline = JSON.parse(readFileSync(args.baseline, "utf8")) as BenchReport;
    const regressions = compareBaseline(baseline, report);
    for (const regression of regressions) console.log(regression);
    if (regressions.length > 0) process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
