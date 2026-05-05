// In-memory ring buffer for unhandled HTTP errors.
//
// The errorMiddleware writes here on every catch — both the truly
// unhandled `internal_error` path and the LLM-mapped 502/504 paths.
// `GET /v1/diagnostics/errors` reads from here, RBAC-gated by
// `audit:read`, so operators can correlate a `trace_id` from the CLI
// banner to the underlying server-side cause without SSH-ing into the
// engine container.
//
// Trade-offs:
//   * In-memory only (process-local). Sufficient for a single-droplet
//     deploy and avoids touching Postgres. If you scale horizontally,
//     swap the implementation for a tenant-scoped table or shared
//     log sink — the public API surface stays the same.
//   * Bounded; defaults to 200 entries (override via SK_ERROR_RING_SIZE).
//     Eviction is FIFO.
//   * Stack frames truncated to 8 KiB so a runaway recursion does not
//     blow process memory.

const DEFAULT_CAPACITY = 200;
const MAX_STACK_BYTES = 8 * 1024;

export interface CapturedError {
  trace_id: string | null;
  ts: string;
  tenant_id: string | null;
  method: string;
  path: string;
  status: number;
  code: string;
  message: string;
  stack: string | null;
  /** `unhandled` (catchall) vs the LLM-mapped buckets. */
  bucket: "unhandled" | "llm_provider" | "llm_no_object" | "llm_timeout" | "llm_quota" | "http";
}

export interface ErrorRing {
  record(entry: CapturedError): void;
  tail(opts?: {
    limit?: number;
    since?: Date;
    trace_id?: string;
    tenant_id?: string;
  }): CapturedError[];
  size(): number;
  clear(): void;
}

// errors.ring_size lives in subkit.config.json and is read at the boot
// path — the engine swaps the singleton ring after loadConfig() via
// `replaceErrorRing(getConfig().errors.ring_size)`. Until then this
// default is in effect.

function truncateStack(stack: string | null | undefined): string | null {
  if (!stack) return null;
  if (stack.length <= MAX_STACK_BYTES) return stack;
  return `${stack.slice(0, MAX_STACK_BYTES)}\n…(truncated)`;
}

export function createErrorRing(capacity = DEFAULT_CAPACITY): ErrorRing {
  const buf: CapturedError[] = [];
  return {
    record(entry: CapturedError): void {
      const normalized: CapturedError = { ...entry, stack: truncateStack(entry.stack) };
      buf.push(normalized);
      while (buf.length > capacity) buf.shift();
    },
    tail(opts = {}): CapturedError[] {
      const limit = opts.limit ?? 50;
      let view = buf;
      if (opts.tenant_id) view = view.filter((e) => e.tenant_id === opts.tenant_id);
      if (opts.trace_id) view = view.filter((e) => e.trace_id === opts.trace_id);
      if (opts.since) {
        const cutoff = opts.since.getTime();
        view = view.filter((e) => Date.parse(e.ts) >= cutoff);
      }
      // Newest first — operators want to see the most recent failures.
      return view.slice(-limit).reverse();
    },
    size(): number {
      return buf.length;
    },
    clear(): void {
      buf.length = 0;
    },
  };
}

// Process-wide singleton — a single ring per engine process is the
// right granularity. Tests can `clear()` between cases via the
// exported helper.
export const errorRing: ErrorRing = createErrorRing();
