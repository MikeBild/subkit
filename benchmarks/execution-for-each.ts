// Execution speed benchmark — `for_each` fan-out, sequential vs bounded-parallel.
//
// Proves the bounded-concurrency `for_each` change (engine.ts
// `resolveForEachConcurrency` + the worker-pool iteration path): a
// read-classified request body that used to run one iteration at a time
// now fans out at the auto-selected bound, so an I/O-bound fan-out's
// wall-clock collapses from N×latency to ceil(N/concurrency)×latency.
//
// It drives the REAL engine end-to-end (runExecution against a disposable
// Postgres + a local mock HTTP origin that sleeps a fixed per-request
// delay) — the only thing held constant between the two runs is the
// `for_each_concurrency` field, so the delta is attributable to the
// scheduling change alone.
//
// Requires Docker (testcontainers Postgres). Runs in `permissive` egress
// mode (NODE_ENV != "production"), so the 127.0.0.1 mock origin is
// reachable.
//
// Usage:
//   bun run benchmarks/execution-for-each.ts [--items 24] [--delay-ms 40]
//   bun run benchmarks/execution-for-each.ts --matrix --runs 3

import { runExecution } from "../apps/engine/src/execution/engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
} from "../apps/engine/src/execution/tests/setup.ts";

function arg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

const ITEMS = arg("--items", 24);
const DELAY_MS = arg("--delay-ms", 40);
const RUNS = arg("--runs", 1);
const MATRIX = process.argv.includes("--matrix");

function listArg(flag: string, fallback: number[]): number[] {
  const i = process.argv.indexOf(flag);
  if (i < 0 || !process.argv[i + 1]) return fallback;
  const parsed = process.argv[i + 1]!.split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length > 0 ? parsed : fallback;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

function buildDef(name: string, items: number, concurrency: number | undefined) {
  return {
    name,
    steps: [
      {
        id: "ids",
        kind: "transform",
        language: "javascript",
        expression: `return Array.from({ length: ${items} }, (_, i) => i);`,
      },
      {
        id: "fetch",
        kind: "request",
        method: "GET",
        url: "__MOCK__/item",
        for_each: "(sourceData) => sourceData.ids.data",
        ...(concurrency !== undefined ? { for_each_concurrency: concurrency } : {}),
      },
    ],
  };
}

async function timeRun(
  ctx: Awaited<ReturnType<typeof createEngineCtx>>,
  baseUrl: string,
  label: string,
  items: number,
  concurrency: number | undefined,
): Promise<number> {
  const def = buildDef(`bench-${label}`, items, concurrency);
  // Late-bind the mock origin into the step url now that the server is up.
  def.steps[1]!.url = `${baseUrl}/item`;
  const { workflow_id } = await createWorkflowRow(ctx, def);
  const started = Date.now();
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: null,
  });
  const elapsed = Date.now() - started;
  if (result.status !== "succeeded") {
    throw new Error(`run '${label}' did not succeed: ${result.status}`);
  }
  return elapsed;
}

async function sampleRun(
  ctx: Awaited<ReturnType<typeof createEngineCtx>>,
  baseUrl: string,
  items: number,
  concurrency: number | undefined,
  runs: number,
): Promise<{ p50: number; p95: number; samples: number[] }> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    samples.push(
      await timeRun(
        ctx,
        baseUrl,
        `items-${items}-c-${concurrency ?? "auto"}-${i}`,
        items,
        concurrency,
      ),
    );
  }
  return { p50: percentile(samples, 50), p95: percentile(samples, 95), samples };
}

async function main(): Promise<void> {
  const ctx = await createEngineCtx("bench-for-each");
  const mock = await createMockServer(async (_req, res) => {
    await new Promise((r) => setTimeout(r, DELAY_MS));
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    // Warm the path once (JIT, connection pool, first-query overhead) so
    // neither timed run pays one-off startup costs.
    await timeRun(ctx, mock.baseUrl, "warmup", ITEMS, 1);

    if (MATRIX) {
      const itemCounts = listArg("--item-counts", [10, 50, 100]);
      const concurrencies = listArg("--concurrency", [1, 2, 4, 8, 16]);
      const rows: Array<{
        items: number;
        concurrency: number;
        p50_ms: number;
        p95_ms: number;
        samples_ms: number[];
      }> = [];
      for (const items of itemCounts) {
        for (const concurrency of concurrencies) {
          const stats = await sampleRun(ctx, mock.baseUrl, items, concurrency, RUNS);
          rows.push({
            items,
            concurrency,
            p50_ms: stats.p50,
            p95_ms: stats.p95,
            samples_ms: stats.samples,
          });
        }
      }
      console.log("\n=== for_each execution benchmark matrix ===");
      console.log(`delay=${DELAY_MS}ms runs=${RUNS}`);
      console.log("items\tconcurrency\tp50_ms\tp95_ms\tsamples_ms");
      for (const r of rows) {
        console.log(
          `${r.items}\t${r.concurrency}\t${r.p50_ms}\t${r.p95_ms}\t${r.samples_ms.join(",")}`,
        );
      }
      console.log(
        JSON.stringify({ benchmark: "for_each_execution_matrix", delay_ms: DELAY_MS, rows }),
      );
      return;
    }

    const sequentialMs = await timeRun(ctx, mock.baseUrl, "sequential", ITEMS, 1);
    const parallelMs = await timeRun(ctx, mock.baseUrl, "parallel-auto", ITEMS, undefined);

    const speedup = sequentialMs / parallelMs;
    const idealParallelMs = Math.ceil(ITEMS / 8) * DELAY_MS;

    console.log("\n=== for_each execution benchmark ===");
    console.log(`items=${ITEMS}  per-request delay=${DELAY_MS}ms  auto-concurrency=min(items,8)`);
    console.log(`sequential (for_each_concurrency:1) : ${sequentialMs} ms`);
    console.log(`bounded-parallel (auto, read GET)   : ${parallelMs} ms`);
    console.log(`speedup                             : ${speedup.toFixed(1)}x`);
    console.log(`ideal lower bound (ceil(N/8)*delay) : ~${idealParallelMs} ms`);
    console.log(
      JSON.stringify({
        benchmark: "for_each_execution",
        items: ITEMS,
        delay_ms: DELAY_MS,
        sequential_ms: sequentialMs,
        parallel_ms: parallelMs,
        speedup: Number(speedup.toFixed(2)),
        ideal_parallel_ms: idealParallelMs,
      }),
    );
  } finally {
    await mock.close();
    await ctx.cleanup();
  }
}

await main();
