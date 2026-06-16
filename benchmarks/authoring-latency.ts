// Authoring-latency benchmark — GROUND doc-loading & recorded-eval repair
// fan-out scheduling.
//
// Scope: this measures the WALL-CLOCK SCHEDULING DELTA of the two
// authoring parallelizations shipped in this change, not absolute
// pipeline latency (which is dominated by the LLM generate call and is
// measured end-to-end by `apps/engine/eval/live-authoring.ts`). The two
// hot spots were strictly sequential `await`-in-a-loop:
//
//   - authoring-pipeline.ts GROUND: `loadDocsExcerpt` per connector
//   - recorded-eval.ts: `repairTransformExpression` per finding (<=3)
//
// Both became `Promise.all`. The wall-clock therefore drops from the SUM
// of the per-task latencies to the MAX (the slowest single task). This
// harness reproduces that exact transformation over a parameterizable
// task count and per-task latency so the delta is quantified with the
// real scheduling primitives — no engine/DB/LLM needed.
//
// The authoring QUALITY of these changes (the previews are still
// content-correct, the repairs still verified) is proven separately and
// is the load-bearing guarantee: `bun run eval` (33 fixtures incl.
// authoring-one-shot-pipeline, authoring-for-each-js-pipeline,
// authoring-repair-roundtrip) stays green — the parallelization is
// quality-neutral.
//
// Usage:
//   bun run benchmarks/authoring-latency.ts [--connectors K] [--repairs R] [--task-ms MS]

function arg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

const CONNECTORS = arg("--connectors", 5);
const REPAIRS = arg("--repairs", 3);
const TASK_MS = arg("--task-ms", 60);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Old shape: await each task before starting the next. */
async function sequential(count: number, perTaskMs: number): Promise<number> {
  const started = Date.now();
  for (let i = 0; i < count; i++) await sleep(perTaskMs);
  return Date.now() - started;
}

/** New shape: fan out, then await all. */
async function parallel(count: number, perTaskMs: number): Promise<number> {
  const started = Date.now();
  await Promise.all(Array.from({ length: count }, () => sleep(perTaskMs)));
  return Date.now() - started;
}

async function main(): Promise<void> {
  console.log("\n=== authoring fan-out scheduling benchmark ===");
  console.log(`per-task latency=${TASK_MS}ms (models one docs-search / one repair invoke)\n`);

  const groundSeq = await sequential(CONNECTORS, TASK_MS);
  const groundPar = await parallel(CONNECTORS, TASK_MS);
  console.log(`GROUND doc-loading  (${CONNECTORS} connectors)`);
  console.log(`  sequential (before): ${groundSeq} ms`);
  console.log(`  Promise.all (after): ${groundPar} ms   → ${(groundSeq / groundPar).toFixed(1)}x`);

  const repairSeq = await sequential(REPAIRS, TASK_MS);
  const repairPar = await parallel(REPAIRS, TASK_MS);
  console.log(`recorded-eval repair fan-out  (${REPAIRS} sites)`);
  console.log(`  sequential (before): ${repairSeq} ms`);
  console.log(`  Promise.all (after): ${repairPar} ms   → ${(repairSeq / repairPar).toFixed(1)}x`);

  console.log(
    `\n${JSON.stringify({
      benchmark: "authoring_fanout_scheduling",
      task_ms: TASK_MS,
      ground: { connectors: CONNECTORS, sequential_ms: groundSeq, parallel_ms: groundPar },
      repair: { sites: REPAIRS, sequential_ms: repairSeq, parallel_ms: repairPar },
    })}`,
  );
}

await main();
