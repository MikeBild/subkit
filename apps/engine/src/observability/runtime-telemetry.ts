// Shared runtime telemetry: timing + memory + success/failure, emitted in
// the canonical structured-log shape (module/action/duration_ms) and mirrored
// to Prometheus gauges/histograms. The goal is that the NDJSON log stream
// alone is a complete analysis surface for *what ran, how long it took, and
// what it cost in memory* — both on the happy path and on failure.
//
// Three primitives, all no-throw (telemetry must never take down a caller):
//   - `instrument()`  — wrap any operation; logs `<action>.completed` /
//                       `<action>.failed` with duration_ms (+ optional rss delta).
//   - boot phases     — `bootPhase()` brackets each startup step with a
//                       start + end marker so a stalled boot points at the
//                       phase it is stuck in instead of a silent gap;
//                       `startBootHeartbeat()` ticks elapsed+rss until ready.
//   - process samplers — `startMemorySampler()` emits the rss/heap series;
//                       `startEventLoopLagMonitor()` flags loop blockage.
//
// Background: production had a 2h22m boot freeze and post-restart event-loop
// stalls that were invisible because nothing emitted timing/memory between the
// one log line before and after the gap. See project_engine_slow_boot_stall.

import { errorFields, log, logger } from "../logging/logger.ts";
import { recordProcessRssHighWater, setDbPoolStats } from "./instrumentation.ts";
import { getMetrics, METRIC_NAMES } from "./metrics.ts";
import { sampleTransientRetryRate } from "./transient-retry-rate.ts";

const BYTES_PER_MB = 1024 * 1024;

function toMb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10;
}

/** Telemetry must never throw into a caller's path. */
function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // Deliberately swallowed — a metrics/log write failure is not worth
    // failing (or even logging again from) the operation being measured.
  }
}

export interface MemorySnapshot {
  rss_mb: number;
  heap_used_mb: number;
  heap_total_mb: number;
  external_mb: number;
  array_buffers_mb: number;
}

/** Point-in-time process memory, rounded to MB for log readability. */
export function sampleMemory(): MemorySnapshot {
  const m = process.memoryUsage();
  return {
    rss_mb: toMb(m.rss),
    heap_used_mb: toMb(m.heapUsed),
    heap_total_mb: toMb(m.heapTotal),
    external_mb: toMb(m.external),
    array_buffers_mb: toMb(m.arrayBuffers ?? 0),
  };
}

// ---------------------------------------------------------------------------
// instrument() — generic operation wrapper
// ---------------------------------------------------------------------------

export interface InstrumentOptions {
  /** Log `module` and the metric `module` label, e.g. "db", "connector". */
  module: string;
  /** Base action; success logs as `<action>.completed`, failure `<action>.failed`. */
  action: string;
  /** Extra structured fields merged into both the success and failure log. */
  fields?: Record<string, unknown>;
  /** Capture an rss-delta around the operation (for heavy ops). Default false. */
  memory?: boolean;
  /** Success log level. Default "info"; use "debug" for hot, low-signal ops. */
  level?: "info" | "debug";
  /** Only emit the success log when duration_ms >= this (failures always log).
   *  Keeps high-frequency fast ops out of the stream while still recording the
   *  metric. Default 0 (always log). */
  thresholdMs?: number;
}

function finishOk(opts: InstrumentOptions, durationMs: number, rssBefore: number): void {
  safe(() => {
    getMetrics().observe(METRIC_NAMES.OPERATION_DURATION_MS, durationMs, {
      module: opts.module,
      action: opts.action,
      outcome: "ok",
    });
  });
  if (durationMs < (opts.thresholdMs ?? 0)) return;
  safe(() => {
    const fields: Record<string, unknown> = {
      module: opts.module,
      action: `${opts.action}.completed`,
      outcome: "ok",
      duration_ms: durationMs,
      ...opts.fields,
    };
    if (opts.memory) {
      const rssNow = process.memoryUsage().rss;
      fields.rss_mb = toMb(rssNow);
      fields.rss_delta_mb = toMb(rssNow - rssBefore);
    }
    (opts.level === "debug" ? logger.debug : logger.info)(fields);
  });
}

function finishErr(
  opts: InstrumentOptions,
  durationMs: number,
  rssBefore: number,
  err: unknown,
): void {
  safe(() => {
    getMetrics().observe(METRIC_NAMES.OPERATION_DURATION_MS, durationMs, {
      module: opts.module,
      action: opts.action,
      outcome: "error",
    });
  });
  safe(() => {
    const fields: Record<string, unknown> = {
      module: opts.module,
      action: `${opts.action}.failed`,
      outcome: "error",
      duration_ms: durationMs,
      ...opts.fields,
      ...errorFields(err),
    };
    if (opts.memory) {
      const rssNow = process.memoryUsage().rss;
      fields.rss_mb = toMb(rssNow);
      fields.rss_delta_mb = toMb(rssNow - rssBefore);
    }
    logger.warn(fields);
  });
}

/**
 * Run `opts.fn`, recording its duration (+ optional memory delta) and outcome.
 * Re-throws on failure after logging, so it is transparent to control flow.
 */
export async function instrument<T>(
  opts: InstrumentOptions & { fn: () => Promise<T> | T },
): Promise<T> {
  const started = Date.now();
  const rssBefore = opts.memory ? process.memoryUsage().rss : 0;
  try {
    const result = await opts.fn();
    finishOk(opts, Date.now() - started, rssBefore);
    return result;
  } catch (err) {
    finishErr(opts, Date.now() - started, rssBefore, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Boot-phase instrumentation
// ---------------------------------------------------------------------------

/**
 * Bracket one named boot phase with a `start` marker (emitted BEFORE the work)
 * and an `ok`/`error` marker (emitted after, with duration + rss). The start
 * marker is the key signal: if boot freezes, the last `boot.phase status=start`
 * line names the phase it is stuck in — converting the old silent multi-minute
 * gap into an attributable stall.
 */
export async function bootPhase<T>(phase: string, fn: () => Promise<T> | T): Promise<T> {
  const started = Date.now();
  log.boot.phase({ phase, status: "start", rss_mb: sampleMemory().rss_mb });
  try {
    const result = await fn();
    const duration_ms = Date.now() - started;
    const snap = sampleMemory();
    log.boot.phase({
      phase,
      status: "ok",
      duration_ms,
      rss_mb: snap.rss_mb,
      heap_used_mb: snap.heap_used_mb,
    });
    safe(() => getMetrics().observe(METRIC_NAMES.BOOT_PHASE_DURATION_MS, duration_ms, { phase }));
    return result;
  } catch (err) {
    log.boot.phase({
      phase,
      status: "error",
      duration_ms: Date.now() - started,
      ...errorFields(err),
    });
    throw err;
  }
}

/**
 * Start a heartbeat that logs elapsed + rss every `intervalMs` until the
 * returned stop fn is called (at `engine.ready`). Catches boot stalls that
 * yield to the event loop; a fully-synchronous stall still surfaces via the
 * unmatched `bootPhase` start marker. The timer is `unref`'d so it never keeps
 * the process alive.
 */
export function startBootHeartbeat(opts?: { intervalMs?: number }): () => void {
  const intervalMs = opts?.intervalMs ?? 5_000;
  const started = Date.now();
  const timer = setInterval(() => {
    safe(() =>
      log.boot.heartbeat({ elapsed_ms: Date.now() - started, rss_mb: sampleMemory().rss_mb }),
    );
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Process samplers
// ---------------------------------------------------------------------------

/**
 * Emit a periodic `process.memory.sample` log + refresh the rss/heap gauges.
 * This is the missing in-process memory time-series: before it, a multi-GB
 * transient was only visible post-mortem via systemd's `memory peak`, with no
 * way to attribute it to a tenant/turn. Fires once immediately, then every
 * `intervalMs`. Returns a stop fn. Timer is `unref`'d.
 */
/** Current Postgres-pool counts, supplied by the caller so this module
 *  doesn't import db/client.ts (which imports `instrument` from here — a
 *  cycle). `startMemorySampler` calls it once per tick and feeds the
 *  predictive pool gauges. */
export type PoolStatsProvider = () => { total: number; idle: number; waiting: number };

export function startMemorySampler(opts?: {
  intervalMs?: number;
  poolStats?: PoolStatsProvider;
}): () => void {
  const intervalMs = opts?.intervalMs ?? 60_000;
  const tick = (): void =>
    safe(() => {
      const m = process.memoryUsage();
      const reg = getMetrics();
      reg.set(METRIC_NAMES.PROCESS_MEMORY_RSS_BYTES, m.rss, {});
      reg.set(METRIC_NAMES.PROCESS_MEMORY_HEAP_USED_BYTES, m.heapUsed, {});
      reg.set(METRIC_NAMES.PROCESS_MEMORY_HEAP_TOTAL_BYTES, m.heapTotal, {});
      reg.set(METRIC_NAMES.PROCESS_MEMORY_EXTERNAL_BYTES, m.external, {});
      // Phase 2: max-ever RSS (climb-only), windowed transient-retry rate, and
      // Postgres-pool saturation gauges, all riding this existing 60s ticker.
      recordProcessRssHighWater(m.rss);
      sampleTransientRetryRate();
      if (opts?.poolStats) {
        const p = opts.poolStats();
        setDbPoolStats({ total: p.total, idle: p.idle, waiting: p.waiting });
      }
      log.process.memory({
        rss_mb: toMb(m.rss),
        heap_used_mb: toMb(m.heapUsed),
        heap_total_mb: toMb(m.heapTotal),
        external_mb: toMb(m.external),
        array_buffers_mb: toMb(m.arrayBuffers ?? 0),
        uptime_s: Math.round(process.uptime()),
      });
    });
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  tick();
  return () => clearInterval(timer);
}

/**
 * Detect event-loop blockage by measuring how late a fixed-interval timer
 * fires. Refreshes the `event_loop_lag_ms` gauge every tick and emits a
 * `process.event_loop.lag` warn only when lag crosses `thresholdMs` (so the
 * steady state is quiet). Returns a stop fn. Timer is `unref`'d.
 */
/**
 * Synchronous-phase profiler for the event-loop-lag hunt. Wraps a hot-path
 * phase and logs a structured warn when it exceeds `thresholdMs` — the
 * production lag warnings (median ~1.6s) name the SYMPTOM but not the
 * blocking phase; these markers name the phase. Near-zero overhead on the
 * fast path (two Date.now() calls), so they stay in permanently.
 */
// Allocation attribution: memory.sample showed ~700MB of EXTERNAL (native
// string) allocation per conversation turn with no slow phase — GC over that
// churn is the residual event_loop.lag. Each marker therefore also reports
// the phase's external-memory delta when it crosses this floor, so the log
// stream names the ALLOCATOR, not just slow code.
const ALLOC_DELTA_FLOOR_BYTES = 64 * 1024 * 1024;

function reportPhase(
  phase: string,
  start: number,
  externalBefore: number,
  thresholdMs: number,
  blocking: boolean,
): void {
  const duration = Date.now() - start;
  const externalDelta = process.memoryUsage().external - externalBefore;
  if (duration < thresholdMs && externalDelta < ALLOC_DELTA_FLOOR_BYTES) return;
  safe(() =>
    logger.warn({
      module: "process",
      action: duration >= thresholdMs ? "phase.slow" : "phase.alloc",
      msg:
        duration >= thresholdMs
          ? blocking
            ? "synchronous phase exceeded the event-loop budget"
            : "phase exceeded the latency budget"
          : "phase allocated heavily (external/native memory)",
      phase,
      duration_ms: duration,
      external_delta_mb: Math.round(externalDelta / (1024 * 1024)),
    }),
  );
}

export function timePhase<T>(phase: string, fn: () => T, thresholdMs = 250): T {
  const start = Date.now();
  const externalBefore = process.memoryUsage().external;
  try {
    return fn();
  } finally {
    reportPhase(phase, start, externalBefore, thresholdMs, true);
  }
}

/** Async variant — measures wall time of the awaited phase. A slow result
 *  here means "this phase took long", not necessarily "blocked the loop";
 *  correlate with event_loop.lag timestamps to tell I/O waits from sync
 *  stalls. */
export async function timePhaseAsync<T>(
  phase: string,
  fn: () => Promise<T>,
  thresholdMs = 250,
): Promise<T> {
  const start = Date.now();
  const externalBefore = process.memoryUsage().external;
  try {
    return await fn();
  } finally {
    reportPhase(phase, start, externalBefore, thresholdMs, false);
  }
}

export function startEventLoopLagMonitor(opts?: {
  intervalMs?: number;
  thresholdMs?: number;
}): () => void {
  const intervalMs = opts?.intervalMs ?? 5_000;
  const thresholdMs = opts?.thresholdMs ?? 250;
  let last = Date.now();
  const tick = (): void => {
    const now = Date.now();
    const lag = Math.max(0, now - last - intervalMs);
    last = now;
    safe(() => getMetrics().set(METRIC_NAMES.EVENT_LOOP_LAG_MS, lag, {}));
    if (lag >= thresholdMs) {
      safe(() =>
        log.process.eventLoopLag({
          lag_ms: lag,
          threshold_ms: thresholdMs,
          rss_mb: toMb(process.memoryUsage().rss),
        }),
      );
    }
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
