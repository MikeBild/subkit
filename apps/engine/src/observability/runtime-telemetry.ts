import { errorFields, log, logger } from "../logging/logger.ts";
import { recordProcessRssHighWater, setDbPoolStats } from "./instrumentation.ts";
import { getMetrics, METRIC_NAMES } from "./metrics.ts";
import { sampleTransientRetryRate } from "./transient-retry-rate.ts";

const BYTES_PER_MB = 1024 * 1024;

function toMb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10;
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {}
}

export interface MemorySnapshot {
  rss_mb: number;
  heap_used_mb: number;
  heap_total_mb: number;
  external_mb: number;
  array_buffers_mb: number;
}

export function readMemoryUsage(): NodeJS.MemoryUsage {
  try {
    return process.memoryUsage();
  } catch {
    return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
  }
}

export function sampleMemory(): MemorySnapshot {
  const m = readMemoryUsage();
  return {
    rss_mb: toMb(m.rss),
    heap_used_mb: toMb(m.heapUsed),
    heap_total_mb: toMb(m.heapTotal),
    external_mb: toMb(m.external),
    array_buffers_mb: toMb(m.arrayBuffers ?? 0),
  };
}

export interface InstrumentOptions {
  module: string;
  action: string;
  fields?: Record<string, unknown>;
  memory?: boolean;
  level?: "info" | "debug";
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
      const rssNow = readMemoryUsage().rss;
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
      const rssNow = readMemoryUsage().rss;
      fields.rss_mb = toMb(rssNow);
      fields.rss_delta_mb = toMb(rssNow - rssBefore);
    }
    logger.warn(fields);
  });
}

export async function instrument<T>(
  opts: InstrumentOptions & { fn: () => Promise<T> | T },
): Promise<T> {
  const started = Date.now();
  const rssBefore = opts.memory ? readMemoryUsage().rss : 0;
  try {
    const result = await opts.fn();
    finishOk(opts, Date.now() - started, rssBefore);
    return result;
  } catch (err) {
    finishErr(opts, Date.now() - started, rssBefore, err);
    throw err;
  }
}

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

export function startBootHeartbeat(opts?: {
  intervalMs?: number;
  slowBootMs?: number;
}): () => void {
  const intervalMs = opts?.intervalMs ?? 5_000;
  const slowBootMs = opts?.slowBootMs ?? 20_000;
  const started = Date.now();
  const timer = setInterval(() => {
    safe(() => {
      const ctx = { elapsed_ms: Date.now() - started, rss_mb: sampleMemory().rss_mb };
      (ctx.elapsed_ms >= slowBootMs ? log.boot.heartbeatSlow : log.boot.heartbeat)(ctx);
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

export type PoolStatsProvider = () => { total: number; idle: number; waiting: number };

export function startMemorySampler(opts?: {
  intervalMs?: number;
  poolStats?: PoolStatsProvider;
}): () => void {
  const intervalMs = opts?.intervalMs ?? 60_000;
  const tick = (): void =>
    safe(() => {
      const m = readMemoryUsage();
      const reg = getMetrics();
      reg.set(METRIC_NAMES.PROCESS_MEMORY_RSS_BYTES, m.rss, {});
      reg.set(METRIC_NAMES.PROCESS_MEMORY_HEAP_USED_BYTES, m.heapUsed, {});
      reg.set(METRIC_NAMES.PROCESS_MEMORY_HEAP_TOTAL_BYTES, m.heapTotal, {});
      reg.set(METRIC_NAMES.PROCESS_MEMORY_EXTERNAL_BYTES, m.external, {});
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

const ALLOC_DELTA_FLOOR_BYTES = 64 * 1024 * 1024;

function reportPhase(
  phase: string,
  start: number,
  externalBefore: number,
  thresholdMs: number,
  blocking: boolean,
): void {
  const duration = Date.now() - start;
  const externalDelta = readMemoryUsage().external - externalBefore;
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
  const externalBefore = readMemoryUsage().external;
  try {
    return fn();
  } finally {
    reportPhase(phase, start, externalBefore, thresholdMs, true);
  }
}

export async function timePhaseAsync<T>(
  phase: string,
  fn: () => Promise<T>,
  thresholdMs = 250,
): Promise<T> {
  const start = Date.now();
  const externalBefore = readMemoryUsage().external;
  try {
    return await fn();
  } finally {
    reportPhase(phase, start, externalBefore, thresholdMs, false);
  }
}

let lastEventLoopLagMs = 0;

export function getLastEventLoopLagMs(): number {
  return lastEventLoopLagMs;
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
    lastEventLoopLagMs = lag;
    safe(() => getMetrics().set(METRIC_NAMES.EVENT_LOOP_LAG_MS, lag, {}));
    if (lag >= thresholdMs) {
      safe(() =>
        log.process.eventLoopLag({
          lag_ms: lag,
          threshold_ms: thresholdMs,
          rss_mb: toMb(readMemoryUsage().rss),
        }),
      );
    }
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
