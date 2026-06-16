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
//   bun run benchmarks/execution-for-each.ts [--items N] [--delay-ms MS]

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

function buildDef(name: string, concurrency: number | undefined) {
  return {
    name,
    steps: [
      {
        id: "ids",
        kind: "transform",
        language: "javascript",
        expression: `return Array.from({ length: ${ITEMS} }, (_, i) => i);`,
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
  concurrency: number | undefined,
): Promise<number> {
  const def = buildDef(`bench-${label}`, concurrency);
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
    await timeRun(ctx, mock.baseUrl, "warmup", 1);

    const sequentialMs = await timeRun(ctx, mock.baseUrl, "sequential", 1);
    const parallelMs = await timeRun(ctx, mock.baseUrl, "parallel-auto", undefined);

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
