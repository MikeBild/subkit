// In-memory ring buffer of structured log entries.
//
// Drives `GET /v1/diagnostics/logs` and `GET /v1/diagnostics/logs/stream`
// so an operator running `sk logs --follow` can correlate CLI-side
// errors with engine-side log lines without SSH-ing into the engine
// container. The logger's `emit()` calls `logRing.record(...)` after
// writing to stdout/stderr; subscribers receive a copy via the
// observable interface below.
//
// Trade-offs:
//   * In-memory only (process-local). Sufficient for a single-droplet
//     deploy and avoids touching Postgres. If you scale horizontally,
//     swap the implementation for a Loki/CloudWatch sink — the public
//     API surface stays the same.
//   * Bounded; defaults to 10 000 entries (override via SK_LOG_RING_SIZE).
//     Eviction is FIFO.
//   * Tenant-agnostic. Boot-time logs and many cross-tenant subsystem
//     logs do not carry a tenant_id, and an operator with `audit:read`
//     is allowed to see them by design.

const DEFAULT_CAPACITY_FROM_ENV = (): number => {
  const raw = process.env.SK_LOG_RING_SIZE;
  if (!raw) return 10_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 10_000;
  return Math.floor(n);
};

export interface CapturedLog {
  /** Wall-clock unix-ms when the log line was emitted. */
  ts: number;
  level: string;
  module?: string | undefined;
  action?: string | undefined;
  msg?: string | undefined;
  /** Trailing fields after stripping module / action / msg. Already
   *  redacted by the logger before reaching the ring. */
  fields: Record<string, unknown>;
}

export interface LogRing {
  record(entry: CapturedLog): void;
  tail(opts?: {
    /** Return entries with `ts >= since_ms`. */
    since_ms?: number;
    /** Cap the number returned (oldest-first slice when since_ms is set,
     *  newest-first slice when only `limit` is given). */
    limit?: number;
    module?: string;
    action?: string;
    /** Minimum level — entries below this weight are dropped. Optional. */
    min_level?: string;
  }): CapturedLog[];
  size(): number;
  capacity(): number;
  clear(): void;
  subscribe(handler: (entry: CapturedLog) => void): () => void;
}

const LEVEL_WEIGHT: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function weight(level: string): number {
  return LEVEL_WEIGHT[level.toLowerCase()] ?? 0;
}

export function createLogRing(capacity = DEFAULT_CAPACITY_FROM_ENV()): LogRing {
  const buf: CapturedLog[] = [];
  const subs = new Set<(e: CapturedLog) => void>();

  const matches = (e: CapturedLog, opts: NonNullable<Parameters<LogRing["tail"]>[0]>): boolean => {
    if (opts.since_ms !== undefined && e.ts < opts.since_ms) return false;
    if (opts.module && e.module !== opts.module) return false;
    if (opts.action && e.action !== opts.action) return false;
    if (opts.min_level && weight(e.level) < weight(opts.min_level)) return false;
    return true;
  };

  return {
    record(entry: CapturedLog): void {
      buf.push(entry);
      while (buf.length > capacity) buf.shift();
      if (subs.size > 0) {
        for (const sub of subs) {
          // A misbehaving subscriber must not break the logger.
          try {
            sub(entry);
          } catch {
            /* ignore subscriber errors */
          }
        }
      }
    },
    tail(opts = {}): CapturedLog[] {
      const limit = opts.limit ?? 200;
      const filtered = buf.filter((e) => matches(e, opts));
      // When the caller provides since_ms they're polling chronologically
      // and want oldest-first; otherwise (initial pull) give newest-first.
      if (opts.since_ms !== undefined) return filtered.slice(0, limit);
      return filtered.slice(-limit).reverse();
    },
    size(): number {
      return buf.length;
    },
    capacity(): number {
      return capacity;
    },
    clear(): void {
      buf.length = 0;
    },
    subscribe(handler): () => void {
      subs.add(handler);
      return () => {
        subs.delete(handler);
      };
    },
  };
}

/**
 * Process-wide singleton. The logger writes here on every `emit()`; the
 * `/v1/diagnostics/logs*` routes read from it. Tests can `clear()`
 * between cases.
 */
export const logRing: LogRing = createLogRing();
