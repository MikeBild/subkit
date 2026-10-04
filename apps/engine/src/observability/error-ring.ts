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

export const errorRing: ErrorRing = createErrorRing();
