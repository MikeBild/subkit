import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PerformanceObserver } from "node:perf_hooks";
import { getContext } from "../logging/context.ts";
import { logger } from "../logging/logger.ts";
import { getLastEventLoopLagMs, sampleMemory } from "./runtime-telemetry.ts";

export function runtimeDiagnosticsEnabled(): boolean {
  return process.env.SUBKIT_DIAGNOSTICS === "1";
}

export interface PoolCounts {
  total: number;
  idle: number;
  waiting: number;
  max?: number;
}

export type PoolCountsProvider = () => PoolCounts | null | undefined;

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function runtimeDiagnosticOptions(): { interval_ms: number; max_samples: number } {
  return {
    interval_ms: boundedInt(process.env.SUBKIT_DIAGNOSTICS_INTERVAL_MS, 1_000, 250, 60_000),
    max_samples: boundedInt(process.env.SUBKIT_DIAGNOSTICS_MAX_SAMPLES, 300, 1, 3_600),
  };
}

function snapshot(provider: PoolCountsProvider | undefined): PoolCounts | null {
  try {
    return provider?.() ?? null;
  } catch {
    return null;
  }
}

function namedPool(name: "app" | "boss", counts: PoolCounts | null): Record<string, number | null> {
  return {
    [`${name}_pool_total`]: counts?.total ?? null,
    [`${name}_pool_idle`]: counts?.idle ?? null,
    [`${name}_pool_waiting`]: counts?.waiting ?? null,
    [`${name}_pool_max`]: counts?.max ?? null,
  };
}

export function runtimeDiagnosticEvent(action: string, fields: Record<string, unknown> = {}): void {
  if (!runtimeDiagnosticsEnabled()) return;
  logger.info({ module: "diagnostics", action, ...fields });
}

function safeErrorFields(error: unknown): { error_kind: "database_or_runtime"; sqlstate?: string } {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code))
      return { error_kind: "database_or_runtime", sqlstate: candidate.code };
    current = candidate.cause;
  }
  return { error_kind: "database_or_runtime" };
}

export async function diagnoseOperation<T>(args: {
  action: string;
  pool?: "app" | "boss";
  poolCounts?: PoolCountsProvider;
  fn: () => Promise<T>;
}): Promise<T> {
  if (!runtimeDiagnosticsEnabled()) return await args.fn();
  const started = Date.now();
  try {
    const result = await args.fn();
    runtimeDiagnosticEvent(`${args.action}.completed`, {
      duration_ms: Date.now() - started,
      event_loop_lag_ms: getLastEventLoopLagMs(),
      ...(args.pool ? namedPool(args.pool, snapshot(args.poolCounts)) : {}),
    });
    return result;
  } catch (error) {
    runtimeDiagnosticEvent(`${args.action}.failed`, {
      duration_ms: Date.now() - started,
      event_loop_lag_ms: getLastEventLoopLagMs(),
      ...(args.pool ? namedPool(args.pool, snapshot(args.poolCounts)) : {}),
      ...safeErrorFields(error),
    });
    throw error;
  }
}

const lastQueryFinishedAt = new Map<string, number>();
let queryEvents = 0;
let queryLimitReported = false;

function diagnosticQueryEventLimit(): number {
  return boundedInt(process.env.SUBKIT_DIAGNOSTICS_MAX_QUERY_EVENTS, 5_000, 1, 50_000);
}

export function beginDiagnosticTransaction(): string | undefined {
  if (!runtimeDiagnosticsEnabled()) return undefined;
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export function endDiagnosticTransaction(txId: string | undefined): void {
  if (txId) lastQueryFinishedAt.delete(txId);
}

export async function diagnoseQuery<T>(args: {
  action: "db.query" | "boss.query";
  backend_pid?: number;
  pool?: "app" | "boss";
  poolCounts?: PoolCountsProvider;
  fn: () => Promise<T>;
}): Promise<T> {
  if (!runtimeDiagnosticsEnabled()) return await args.fn();
  if (queryEvents >= diagnosticQueryEventLimit()) {
    if (!queryLimitReported) {
      queryLimitReported = true;
      runtimeDiagnosticEvent("runtime.query_limit_reached", { max_query_events: queryEvents });
    }
    return await args.fn();
  }
  queryEvents++;
  const started = Date.now();
  const txId = getContext().db_tx_id;
  const prior = txId ? lastQueryFinishedAt.get(txId) : undefined;
  const shared = {
    ...(txId ? { db_tx_id: txId } : {}),
    ...(typeof prior === "number" ? { interquery_gap_ms: Math.max(0, started - prior) } : {}),
    ...(typeof args.backend_pid === "number" ? { backend_pid: args.backend_pid } : {}),
    ...(args.pool ? namedPool(args.pool, snapshot(args.poolCounts)) : {}),
  };
  try {
    const result = await args.fn();
    if (txId) lastQueryFinishedAt.set(txId, Date.now());
    runtimeDiagnosticEvent(`${args.action}.completed`, {
      duration_ms: Date.now() - started,
      event_loop_lag_ms: getLastEventLoopLagMs(),
      ...shared,
    });
    return result;
  } catch (error) {
    if (txId) lastQueryFinishedAt.set(txId, Date.now());
    runtimeDiagnosticEvent(`${args.action}.failed`, {
      duration_ms: Date.now() - started,
      event_loop_lag_ms: getLastEventLoopLagMs(),
      ...shared,
      ...safeErrorFields(error),
    });
    throw error;
  }
}

type CpuCounters = { usage_usec: number; throttled_usec: number; nr_throttled: number };

function cgroupCpuCounters(): CpuCounters | null {
  try {
    const raw = readFileSync("/sys/fs/cgroup/cpu.stat", "utf8");
    const values = new Map(
      raw
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/, 2))
        .filter((parts): parts is [string, string] => parts.length === 2 && parts[1] !== undefined),
    );
    const number = (key: string) => Number.parseInt(values.get(key) ?? "0", 10) || 0;
    return {
      usage_usec: number("usage_usec"),
      throttled_usec: number("throttled_usec"),
      nr_throttled: number("nr_throttled"),
    };
  } catch {
    return null;
  }
}

export function startRuntimeDiagnosticSampler(args: {
  appPool: PoolCountsProvider;
  bossPool?: PoolCountsProvider;
  advisoryLockSnapshot?: () => Promise<{
    waiters: Array<{ waiter_backend_pid: number; blocker_backend_pids: number[] }>;
  }>;
}): () => void {
  if (!runtimeDiagnosticsEnabled()) return () => {};
  const { interval_ms, max_samples } = runtimeDiagnosticOptions();
  let samples = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastWall = Date.now();
  let lastCpu = process.cpuUsage();
  let lastCgroup = cgroupCpuCounters();
  let lockSnapshotInFlight = false;
  const gc =
    process.env.SUBKIT_DIAGNOSTICS_GC === "1"
      ? new PerformanceObserver((items) => {
          for (const entry of items.getEntries()) {
            const gcEntry = entry as PerformanceEntry & { detail?: { kind?: number } };
            runtimeDiagnosticEvent("runtime.gc", {
              duration_ms: Math.round(entry.duration * 1000) / 1000,
              kind: gcEntry.detail?.kind ?? null,
            });
          }
        })
      : null;
  gc?.observe({ entryTypes: ["gc"] });
  const tick = () => {
    const now = Date.now();
    const cpu = process.cpuUsage();
    const wallMs = Math.max(1, now - lastWall);
    const cpuUsec = cpu.user - lastCpu.user + cpu.system - lastCpu.system;
    const cgroup = cgroupCpuCounters();
    samples++;
    runtimeDiagnosticEvent("runtime.sample", {
      sample: samples,
      max_samples,
      event_loop_lag_ms: getLastEventLoopLagMs(),
      ...sampleMemory(),
      ...namedPool("app", snapshot(args.appPool)),
      ...namedPool("boss", snapshot(args.bossPool)),
      process_cpu_pct: Math.round((cpuUsec / (wallMs * 1000)) * 10_000) / 100,
      ...(cgroup && lastCgroup
        ? {
            cgroup_cpu_usec: cgroup.usage_usec - lastCgroup.usage_usec,
            cgroup_throttled_usec: cgroup.throttled_usec - lastCgroup.throttled_usec,
            cgroup_throttled_events: cgroup.nr_throttled - lastCgroup.nr_throttled,
          }
        : {}),
    });
    lastWall = now;
    lastCpu = cpu;
    lastCgroup = cgroup;
    if (
      process.env.SUBKIT_DIAGNOSTICS_LOCK_SNAPSHOT === "1" &&
      args.advisoryLockSnapshot &&
      !lockSnapshotInFlight
    ) {
      lockSnapshotInFlight = true;
      void args
        .advisoryLockSnapshot()
        .then((locks) => {
          for (const waiter of locks.waiters)
            runtimeDiagnosticEvent("runtime.advisory_locks", waiter);
        })
        .catch(() => runtimeDiagnosticEvent("runtime.advisory_locks.failed"))
        .finally(() => {
          lockSnapshotInFlight = false;
        });
    }
    if (samples >= max_samples && timer) {
      clearInterval(timer);
      timer = null;
      runtimeDiagnosticEvent("runtime.sample_limit_reached", { max_samples });
    }
  };
  runtimeDiagnosticEvent("runtime.enabled", { interval_ms, max_samples });
  tick();
  timer = setInterval(tick, interval_ms);
  timer.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    gc?.disconnect();
  };
}
