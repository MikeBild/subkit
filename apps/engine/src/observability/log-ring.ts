// In-memory ring buffer of structured log entries.
//
// Drives `GET /v1/diagnostics/logs` and `GET /v1/diagnostics/logs/stream`
// so an operator running `sk logs --follow` can correlate CLI-side
// errors with engine-side log lines without SSH-ing into the engine
// container. The logger's `emit()` calls `logRing.record(...)` after
// writing to stdout/stderr; subscribers receive a copy via the
// observable interface below.
//
// Tenant scoping: entries carry the tenant_id their request context
// supplied (boot-time + cross-tenant subsystem logs use the sentinel
// `"system"` or no tenant_id at all). The diagnostics route filters
// reads to the requesting principal's tenant + system-scope only,
// so a tenant-scoped admin cannot see another tenant's request lines.
//
// Trade-offs:
//   * In-memory only (process-local). Sufficient for a single-droplet
//     deploy and avoids touching Postgres. If you scale horizontally,
//     swap the implementation for a Loki/CloudWatch sink — the public
//     API surface stays the same.
//   * Bounded; defaults to 10 000 entries (override via SK_LOG_RING_SIZE).
//     Eviction is FIFO.

import { SYSTEM_TENANT_ID } from "../audit/types.ts";

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

/**
 * Sentinel values used by the diagnostics route to mark "no tenant
 * scope" — boot-time / cross-tenant subsystem logs end up here.
 * Tenant-scoped admins are allowed to see these in addition to their
 * own tenant's lines, because (a) they have no other source of
 * operational visibility into engine boot and (b) the lines themselves
 * are sanitized through the logger's redact() pass.
 *
 * Members:
 *   - `SYSTEM_TENANT_ID` ("00000000-0000-0000-0000-000000000000"):
 *     the canonical UUID used by `audit/types.ts` for system-scope
 *     audit writes AND by the engine boot path's `withContext` wrapper
 *     (`apps/engine/src/index.ts`). Standardized on the UUID by
 *     review R2-W6.
 *   - `""`:  empty string — defensively treat as missing.
 *   - `"system"`:  legacy literal kept as a defensive fallback for
 *     out-of-tree forks that may still emit it; the in-tree boot path
 *     no longer uses it.
 */
export const SYSTEM_TENANT_TOKENS = new Set<string>([SYSTEM_TENANT_ID, "", "system"]);

/**
 * Extract the tenant_id an entry was emitted under. Returns `null`
 * when the field is absent (which the route treats as system-scope).
 */
export function entryTenantId(entry: CapturedLog): string | null {
  const v = entry.fields?.tenant_id;
  if (typeof v !== "string") return null;
  return v;
}

/**
 * Predicate the route uses to decide whether `entry` is visible to
 * `principal_tenant_id`. Exported so the SSE handler and the
 * paginated tail apply the same rule.
 */
export function isEntryVisibleToTenant(entry: CapturedLog, principal_tenant_id: string): boolean {
  const t = entryTenantId(entry);
  if (t === null) return true;
  if (SYSTEM_TENANT_TOKENS.has(t)) return true;
  return t === principal_tenant_id;
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
    /** Restrict to entries whose `fields.tenant_id` matches this value
     *  OR is null/`"system"`. The diagnostics route always supplies
     *  this; tests that exercise the raw ring may omit it. */
    visible_to_tenant?: string;
  }): CapturedLog[];
  size(): number;
  capacity(): number;
  clear(): void;
  subscribe(handler: (entry: CapturedLog) => void): () => void;
}

// Single source: re-export the cli-core helper so the engine logger,
// the diagnostics route, and the `sk logs` CLI all read the same map
// (review R2-S1).
export { logLevelWeight as levelWeight } from "@cli-core/log-levels.ts";

import { logLevelWeight } from "@cli-core/log-levels.ts";

function weight(level: string): number {
  return logLevelWeight(level);
}

export function createLogRing(capacity = DEFAULT_CAPACITY_FROM_ENV()): LogRing {
  const buf: CapturedLog[] = [];
  const subs = new Set<(e: CapturedLog) => void>();

  const matches = (e: CapturedLog, opts: NonNullable<Parameters<LogRing["tail"]>[0]>): boolean => {
    if (opts.since_ms !== undefined && e.ts < opts.since_ms) return false;
    if (opts.module && e.module !== opts.module) return false;
    if (opts.action && e.action !== opts.action) return false;
    if (opts.min_level && weight(e.level) < weight(opts.min_level)) return false;
    if (opts.visible_to_tenant !== undefined && !isEntryVisibleToTenant(e, opts.visible_to_tenant))
      return false;
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
