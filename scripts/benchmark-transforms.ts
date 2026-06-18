#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../apps/engine/src/config/loader.ts";
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
  skipConfig: boolean;
}

const DEFAULT_OUT = join(process.cwd(), "apps/engine/eval/out/transform-benchmark.json");

function parseArgs(argv: string[]): CliArgs {
  let iterations = 100;
  let out = DEFAULT_OUT;
  let baseline: string | null = null;
  let skipConfig = false;
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
    // --skip-config measures the pre-boot fallback path (getConfig() throws,
    // runJs catches and uses DEFAULT_LIMITS). Default loads config so the
    // benchmark exercises the production path (getConfig() returns).
    else if (arg === "--skip-config") skipConfig = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run scripts/benchmark-transforms.ts [--iterations 100] [--out report.json] [--baseline report.json] [--skip-config]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("--iterations must be a positive integer");
  }
  return { iterations, out, baseline, skipConfig };
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

  // Load engine config so runJs exercises the production limit-resolution
  // path (getConfig().sandbox) rather than the pre-boot fallback where
  // getConfig() throws and runJs catches into DEFAULT_LIMITS. Without this
  // the benchmark measures an exception-per-call that never happens in
  // prod. `--skip-config` opts back into the fallback path to quantify it.
  if (!args.skipConfig) {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x:y@127.0.0.1:5432/z", NODE_ENV: "test" },
      configPathOverride: join(mkdtempSync(join(tmpdir(), "sk-bench-")), "subkit.config.json"),
    });
  }
  console.log(
    `config: ${args.skipConfig ? "skipped (fallback path)" : "loaded (production path)"}`,
  );

  // `rows` (25) keeps the legacy base64/arith workloads stable; `big`
  // (5000) drives the data-heavy projection where memory, not CPU, is the
  // binding constraint for a transform.
  const scope = {
    a: {
      data: {
        n: 21,
        text: "München 😀",
        rows: Array.from({ length: 25 }, (_, n) => ({ n })),
        big: Array.from({ length: 5000 }, (_, n) => ({ n, label: `row-${n}` })),
      },
    },
  };
  const input = { multiplier: 2 };

  // Workloads that succeed on BOTH the pre-change (1 MB stack) and current
  // (2 MB stack) defaults, so the same set is comparable across versions.
  // recursion depth 250 and the 200k loop stay well inside 1 MB / 128 MB.
  const DATA_HEAVY =
    "return input.scope.a.data.big.map(r => ({ n: r.n, sq: r.n * r.n })).reduce((acc, r) => acc + r.sq, 0);";
  const RECURSION = "function d(n){ return n <= 0 ? 0 : 1 + d(n - 1); } return d(250);";
  const COMPUTE_LOOP = "let s = 0; for (let i = 0; i < 200000; i++) { s += i % 7; } return s;";

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
    await bench("quickjs-data-heavy-5k", args.iterations, () =>
      runJs({ code: DATA_HEAVY, input: { scope, input } }),
    ),
    await bench("quickjs-recursion-250", args.iterations, () =>
      runJs({ code: RECURSION, input: null }),
    ),
    await bench("quickjs-compute-loop-200k", args.iterations, () =>
      runJs({ code: COMPUTE_LOOP, input: null }),
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

  // Limit-stats snapshot: the sandbox returns ticks + peak memory per call,
  // so the memory/tick knobs are observed via stats, not the wall clock.
  // (The stack-cap change is a hard ceiling — its effect is a correctness
  // assertion in config-and-stack.test.ts, not a throughput number.)
  const heavy = await runJs({ code: DATA_HEAVY, input: { scope, input } });
  const loop = await runJs({ code: COMPUTE_LOOP, input: null });
  console.log(
    `stats data-heavy-5k: ticks=${heavy.stats.ticks} peak_memory_bytes=${heavy.stats.peak_memory_bytes ?? "null"} duration_ms=${heavy.stats.duration_ms}`,
  );
  console.log(
    `stats compute-loop-200k: ticks=${loop.stats.ticks} peak_memory_bytes=${loop.stats.peak_memory_bytes ?? "null"} duration_ms=${loop.stats.duration_ms}`,
  );

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
