import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { environment } from "./environment.ts";
import type {
  BenchmarkCase,
  BenchmarkCounts,
  BenchmarkLoad,
  BenchmarkManifest,
  BenchmarkProfile,
  BenchmarkRun,
  BenchmarkSample,
} from "./model.ts";

type Runtime = {
  close: () => void;
  runJs: (options: {
    code: string;
    input: unknown;
    clock: { now_ms: number; seed: string };
    limits?: { wall_ms: number; tick_budget: number };
  }) => Promise<unknown>;
  evaluate: (source: string, data: unknown, bindings?: { input?: unknown }) => Promise<unknown>;
};

type Workload = BenchmarkCase & { execute: (runtime: Runtime) => Promise<unknown> };

const MAX_SUCCESS_SAMPLES = 100_000;
const MAX_FAILURE_SAMPLES = 100;

export function sampleRecorder(
  name: string,
  repeat: number,
  concurrency: number,
): {
  record: (sample: BenchmarkSample) => void;
  samples: () => BenchmarkSample[];
  totals: BenchmarkCounts;
} {
  const successes: BenchmarkSample[] = [];
  const failures: BenchmarkSample[] = [];
  const totals: BenchmarkCounts = {
    count: 0,
    ok_count: 0,
    error_count: 0,
    timeout_count: 0,
    rejected_count: 0,
  };
  let state = [...name].reduce(
    (hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0,
    repeat * 65537 + concurrency,
  );
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return {
    record(sample) {
      totals.count += 1;
      if (sample.ok) {
        totals.ok_count += 1;
        if (successes.length < MAX_SUCCESS_SAMPLES) successes.push(sample);
        else {
          const selected = Math.floor(random() * totals.ok_count);
          if (selected < MAX_SUCCESS_SAMPLES) successes[selected] = sample;
        }
      } else {
        if (sample.outcome === "timeout") totals.timeout_count += 1;
        else if (sample.outcome === "rejected") totals.rejected_count += 1;
        else totals.error_count += 1;
        if (failures.length < MAX_FAILURE_SAMPLES) failures.push(sample);
      }
    },
    samples: () => [...successes, ...failures],
    totals,
  };
}

const clock = { now_ms: 1_700_000_000_000, seed: "runtime-benchmark" };
const largeRows = Array.from({ length: 5_000 }, (_, index) => ({
  id: index,
  amount: index % 29,
  enabled: index % 3 !== 0,
}));
const typicalRows = largeRows.slice(0, 500);

function input(rows: typeof largeRows): { rows: typeof largeRows } {
  return { rows };
}

function workloads(): Workload[] {
  return [
    {
      name: "js-small",
      family: "javascript",
      size: "small",
      execute: (runtime) =>
        runtime.runJs({ code: "return input.value + 1;", input: { value: 41 }, clock }),
    },
    {
      name: "js-typical",
      family: "javascript",
      size: "typical",
      execute: (runtime) =>
        runtime.runJs({
          code: "return input.rows.filter((row) => row.enabled).map((row) => ({ id: row.id, amount: row.amount * 1.19 }));",
          input: input(typicalRows),
          clock,
        }),
    },
    {
      name: "js-large",
      family: "javascript",
      size: "large",
      execute: (runtime) =>
        runtime.runJs({
          code: "return input.rows.filter((row) => row.enabled).map((row) => ({ id: row.id, amount: row.amount * 1.19 }));",
          input: input(largeRows),
          clock,
        }),
    },
    {
      name: "jsonata-small",
      family: "jsonata",
      size: "small",
      execute: (runtime) =>
        runtime.evaluate("$input.value + 1", { value: 41 }, { input: { value: 41 } }),
    },
    {
      name: "jsonata-typical",
      family: "jsonata",
      size: "typical",
      execute: (runtime) =>
        runtime.evaluate("$sum($input.rows[enabled].amount)", input(typicalRows), {
          input: input(typicalRows),
        }),
    },
    {
      name: "jsonata-large",
      family: "jsonata",
      size: "large",
      execute: (runtime) =>
        runtime.evaluate("$sum($input.rows[enabled].amount)", input(largeRows), {
          input: input(largeRows),
        }),
    },
    {
      name: "helper-capability",
      family: "helpers",
      size: "small",
      execute: (runtime) =>
        runtime.runJs({ code: "return Object.keys(sk).sort();", input: null, clock }),
    },
    {
      name: "helper-money",
      family: "helpers",
      size: "small",
      execute: (runtime) =>
        runtime.runJs({ code: "return sk.money.add('12.30', '4.56');", input: null, clock }),
    },
    {
      name: "helper-csv",
      family: "helpers",
      size: "typical",
      execute: (runtime) =>
        runtime.runJs({
          code: "return sk.csv.parse('name,amount\\nAda,12\\nLin,4');",
          input: null,
          clock,
        }),
    },
    {
      name: "helper-date",
      family: "helpers",
      size: "small",
      execute: (runtime) =>
        runtime.runJs({
          code: "return sk.date.format('2024-01-02T03:04:05Z', 'yyyy-MM-dd', { zone: 'Europe/Berlin' });",
          input: null,
          clock,
        }),
    },
    {
      name: "helper-schema",
      family: "helpers",
      size: "small",
      execute: (runtime) =>
        runtime.runJs({
          code: "return sk.schema.validate({ type: 'object', required: ['id'] }, { id: 'ok' });",
          input: null,
          clock,
        }),
    },
    {
      name: "helper-url",
      family: "helpers",
      size: "small",
      execute: (runtime) =>
        runtime.runJs({
          code: "return sk.url.build('https://example.test/search', { query: [['q', 'ümlaut'], ['tag', 'a'], ['tag', 'b']] });",
          input: null,
          clock,
        }),
    },
    {
      name: "helper-xml",
      family: "helpers",
      size: "small",
      execute: (runtime) =>
        runtime.runJs({
          code: "return sk.xml.parse('<order id=\"1\"><item>two</item></order>');",
          input: null,
          clock,
        }),
    },
    {
      name: "helper-template-diff",
      family: "helpers",
      size: "small",
      execute: (runtime) =>
        runtime.runJs({
          code: "return sk.diff.records([{ id: 'a', value: 1 }], [{ id: 'a', value: 2 }], { key: 'id' });",
          input: null,
          clock,
        }),
    },
    {
      name: "fault-timeout-recovery",
      family: "fault",
      size: "fault",
      execute: async (runtime) => {
        try {
          await runtime.runJs({
            code: "while (true) {}",
            input: null,
            clock,
            limits: { wall_ms: 10, tick_budget: 2_000 },
          });
        } catch {}
        return runtime.runJs({ code: "return 1;", input: null, clock });
      },
    },
  ];
}

async function loadRuntime(sourceRoot: string): Promise<Runtime> {
  const root = resolve(sourceRoot);
  const quickjs = await import(
    pathToFileURL(`${root}/apps/engine/src/sandboxes/quickjs/runtime.ts`).href
  );
  const jsonata = await import(
    pathToFileURL(`${root}/apps/engine/src/execution/jsonata-engine.ts`).href
  );
  return {
    close: () => quickjs.closeSandboxWorkers?.(),
    runJs: quickjs.runJs as Runtime["runJs"],
    evaluate: jsonata.evaluate as Runtime["evaluate"],
  };
}

export async function sourceSha256(sourceRoot: string): Promise<string> {
  const root = resolve(sourceRoot);
  const files = [
    "bun.lock",
    "apps/engine/src/index.ts",
    "apps/engine/src/engine-main.ts",
    "apps/engine/src/execution/jsonata-engine.ts",
    "apps/engine/src/docs-ingestion/parsers/index.ts",
  ];
  for await (const file of new Bun.Glob("apps/engine/src/sandboxes/quickjs/**/*.{ts,js,json}").scan(
    {
      cwd: root,
    },
  )) {
    if (!file.includes("/tests/") && !file.endsWith(".test.ts")) files.push(file);
  }
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    try {
      hash.update(file);
      hash.update(await readFile(`${root}/${file}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return hash.digest("hex");
}

export async function lockfileSha256(sourceRoot: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(`${resolve(sourceRoot)}/bun.lock`))
    .digest("hex");
}

const execFileAsync = promisify(execFile);
const RSS_SAMPLE_INTERVAL_MS = 1_000;

async function processRss(): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss="], {
      encoding: "utf8",
    });
    const rows = stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(
        (row): row is [number, number, number] => row.length === 3 && row.every(Number.isFinite),
      );
    const descendants = new Set<number>([process.pid]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const [pid, parent] of rows) {
        if (!descendants.has(pid) && descendants.has(parent)) {
          descendants.add(pid);
          changed = true;
        }
      }
    }
    return rows
      .filter(([pid]) => descendants.has(pid))
      .reduce((total, [, , rss]) => total + rss * 1024, 0);
  } catch {
    return process.memoryUsage.rss();
  }
}

function observeRss(initial: number): { peak: () => number; stop: () => void } {
  let stopped = false;
  let peak = initial;
  const sample = async (): Promise<void> => {
    while (!stopped) {
      peak = Math.max(peak, await processRss());
      if (!stopped) await Bun.sleep(RSS_SAMPLE_INTERVAL_MS);
    }
  };
  void sample();
  return {
    peak: () => peak,
    stop: () => {
      stopped = true;
    },
  };
}

async function executeConcurrent(
  workload: Workload,
  runtime: Runtime,
  concurrency: number,
): Promise<BenchmarkSample[]> {
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: concurrency }, async (): Promise<BenchmarkSample> => {
      const taskStarted = performance.now();
      try {
        await workload.execute(runtime);
        return { duration_ms: performance.now() - taskStarted, ok: true };
      } catch (error) {
        return {
          duration_ms: performance.now() - taskStarted,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  if (performance.now() - started < 0) throw new Error("invalid monotonic clock");
  return results;
}

function failureSample(start: number, error: unknown, intendedAt?: number): BenchmarkSample {
  const message = error instanceof Error ? error.message : String(error);
  return {
    duration_ms: performance.now() - (intendedAt ?? start),
    ok: false,
    outcome: /timeout|deadline|wall[_ -]?ms/i.test(message) ? "timeout" : "error",
    ...(intendedAt === undefined ? {} : { intended_at_ms: intendedAt }),
    error: message,
  };
}

export function openLoopSchedule(options: {
  start_ms: number;
  measure_ms: number;
  offered_rate_per_second: number;
}): number[] {
  if (!Number.isFinite(options.offered_rate_per_second) || options.offered_rate_per_second <= 0) {
    throw new Error("open-loop offered rate must be positive");
  }
  const interval = 1_000 / options.offered_rate_per_second;
  const count = Math.ceil(options.measure_ms / interval);
  return Array.from({ length: count }, (_, index) => options.start_ms + index * interval);
}

async function sleepUntil(intendedAt: number): Promise<void> {
  const remaining = intendedAt - performance.now();
  if (remaining > 0) await Bun.sleep(remaining);
}

async function measureOpenLoop(
  workload: Workload,
  runtime: Runtime,
  profile: BenchmarkProfile,
  load: BenchmarkLoad,
  record: (sample: BenchmarkSample) => void,
): Promise<void> {
  const rate = load.offered_rate_per_second;
  if (!rate) throw new Error("open-loop measurement requires an offered rate");
  const planned = openLoopSchedule({
    start_ms: performance.now(),
    measure_ms: profile.measure_ms,
    offered_rate_per_second: rate,
  });
  const pending = new Set<Promise<void>>();
  let index = 0;
  while (index < planned.length) {
    await sleepUntil(planned[index] ?? performance.now());
    const now = performance.now();
    while (index < planned.length && (planned[index] ?? Infinity) <= now) {
      const intendedAt = planned[index] as number;
      index += 1;
      if (pending.size >= load.max_outstanding) {
        record({
          duration_ms: performance.now() - intendedAt,
          intended_at_ms: intendedAt,
          ok: false,
          outcome: "rejected",
          error: "benchmark outstanding-work limit reached",
        });
        continue;
      }
      const task = (async () => {
        const started = performance.now();
        try {
          await workload.execute(runtime);
          record({
            duration_ms: performance.now() - intendedAt,
            intended_at_ms: intendedAt,
            ok: true,
            outcome: "ok",
          });
        } catch (error) {
          record(failureSample(started, error, intendedAt));
        }
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
  }
  await Promise.all(pending);
}

async function measure(
  workload: Workload,
  runtime: Runtime,
  profile: BenchmarkProfile,
  repeat: number,
  concurrency: number,
): Promise<BenchmarkRun> {
  const warmupEnds = performance.now() + profile.warmup_ms;
  while (performance.now() < warmupEnds) {
    await executeConcurrent(workload, runtime, concurrency);
  }
  const before = await processRss();
  const observer = observeRss(before);
  const measurementStarted = performance.now();
  const load: BenchmarkLoad = {
    ...profile.load,
    max_outstanding: Math.min(profile.load.max_outstanding, concurrency),
  };
  const recorder = sampleRecorder(workload.name, repeat, concurrency);
  try {
    if (load.mode === "open") {
      await measureOpenLoop(workload, runtime, profile, load, recorder.record);
    } else {
      const ends = performance.now() + profile.measure_ms;
      while (performance.now() < ends) {
        for (const sample of await executeConcurrent(workload, runtime, concurrency)) {
          recorder.record(sample);
        }
      }
    }
  } finally {
    observer.stop();
  }
  const measurementElapsed = performance.now() - measurementStarted;
  const after = await processRss();
  return {
    case: { name: workload.name, family: workload.family, size: workload.size },
    repeat,
    concurrency,
    warmup_ms: profile.warmup_ms,
    measure_ms: profile.measure_ms,
    measurement_elapsed_ms: measurementElapsed,
    load,
    samples: recorder.samples(),
    totals: recorder.totals,
    process_memory: {
      before_rss_bytes: before,
      after_rss_bytes: after,
      peak_rss_bytes: Math.max(observer.peak(), after),
    },
  };
}

async function correctness(
  runtime: Runtime,
  requireHelpers: boolean,
): Promise<BenchmarkManifest["correctness"]> {
  const checks: BenchmarkManifest["correctness"] = [];
  for (const [name, fn] of [
    [
      "javascript-result",
      () => runtime.runJs({ code: "return input.value + 1;", input: { value: 41 }, clock }),
    ],
    [
      "jsonata-result",
      () => runtime.evaluate("$input.value + 1", { value: 41 }, { input: { value: 41 } }),
    ],
    [
      "fault-recovery",
      async () => {
        let timedOut = false;
        try {
          await runtime.runJs({
            code: "while (true) {}",
            input: null,
            clock,
            limits: { wall_ms: 10, tick_budget: 2_000 },
          });
        } catch {
          timedOut = true;
        }
        if (!timedOut) throw new Error("fault workload did not reject the infinite loop");
        return runtime.runJs({ code: "return 1;", input: null, clock });
      },
    ],
  ] as const) {
    try {
      const value = await fn();
      const expected = name === "javascript-result" || name === "jsonata-result" ? 42 : undefined;
      const actual =
        typeof value === "object" && value !== null && "output" in value
          ? (value as { output: unknown }).output
          : value;
      checks.push({
        name,
        ok: expected === undefined || actual === expected,
        ...(expected === undefined || actual === expected
          ? {}
          : { detail: `expected ${expected}, received ${String(actual)}` }),
      });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (requireHelpers) {
    const expected = new Map<string, (value: unknown) => boolean>([
      ["helper-money", (value) => value === "16.86"],
      ["helper-csv", (value) => Array.isArray(value) && value.length === 3],
      ["helper-date", (value) => value === "2024-01-02"],
      ["helper-schema", (value) => Boolean((value as { valid?: unknown })?.valid)],
      ["helper-url", (value) => typeof value === "string" && value.includes("q=%C3%BCmlaut")],
      ["helper-xml", (value) => (value as { name?: unknown })?.name === "order"],
      ["helper-template-diff", (value) => Boolean(value)],
    ]);
    for (const workload of workloads().filter(
      (workload) => workload.family === "helpers" && workload.name !== "helper-capability",
    )) {
      try {
        const result = await workload.execute(runtime);
        const output =
          typeof result === "object" && result !== null && "output" in result
            ? (result as { output: unknown }).output
            : result;
        const passes = expected.get(workload.name)?.(output) ?? false;
        checks.push(
          passes
            ? { name: workload.name, ok: true }
            : { name: workload.name, ok: false, detail: "helper returned an unexpected result" },
        );
      } catch (error) {
        checks.push({
          name: workload.name,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return checks;
}

export async function captureBenchmark(options: {
  label: string;
  profile: BenchmarkProfile;
  sourceRoot: string;
  requireHelpers: boolean;
}): Promise<BenchmarkManifest> {
  const startedAt = new Date().toISOString();
  const runtime = await loadRuntime(options.sourceRoot);
  try {
    const runs: BenchmarkRun[] = [];
    for (const workload of workloads().filter(
      (candidate) => !options.profile.cases || options.profile.cases.includes(candidate.name),
    )) {
      for (const concurrency of options.profile.concurrency) {
        for (let repeat = 1; repeat <= options.profile.repeats; repeat += 1) {
          runs.push(await measure(workload, runtime, options.profile, repeat, concurrency));
        }
      }
    }
    return {
      schema: "subkit-runtime-benchmark",
      label: options.label,
      profile: options.profile,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      host: environment(),
      source_root: resolve(options.sourceRoot),
      source_sha256: await sourceSha256(options.sourceRoot),
      lockfile_sha256: await lockfileSha256(options.sourceRoot),
      runs,
      correctness: await correctness(runtime, options.requireHelpers),
    };
  } finally {
    runtime.close();
  }
}

export const profiles: Record<BenchmarkProfileName, BenchmarkProfile> = {
  smoke: {
    name: "smoke",
    warmup_ms: 100,
    measure_ms: 400,
    repeats: 1,
    concurrency: [1, 4],
    load: { mode: "closed", max_outstanding: 64 },
  },
  release: {
    name: "release",
    warmup_ms: 2_000,
    measure_ms: 30_000,
    repeats: 5,
    concurrency: [1, 4],
    cases: ["js-small", "js-typical", "jsonata-small", "jsonata-typical"],
    load: { mode: "closed", max_outstanding: 4 },
  },
  full: {
    name: "full",
    warmup_ms: 60_000,
    measure_ms: 180_000,
    repeats: 5,
    concurrency: [1, 4, 16, 64],
    load: { mode: "closed", max_outstanding: 64 },
  },
};
