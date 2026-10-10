import { errorFields, logger } from "../logging/logger.ts";
import { recordDbTransientRetry } from "../observability/instrumentation.ts";

const TRANSIENT_CODES = new Set<string>([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08006",
  "40001",
]);

const TRANSIENT_MESSAGES = [
  "Connection terminated unexpectedly",
  "terminating connection due to administrator command",
  "Client has encountered a connection error and is not queryable",
];

export function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;

  const message =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown } | null | undefined)?.message === "string"
        ? (err as { message: string }).message
        : null;
  if (message !== null && TRANSIENT_MESSAGES.some((m) => message.includes(m))) return true;

  return false;
}

export interface RetryTransientOptions {
  tries?: number;
  startMs?: number;
  maxMs?: number;
  label?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function jitter(ms: number): number {
  return Math.max(0, ms + (Math.random() * 2 - 1) * ms * 0.2);
}

export async function retryTransient<T>(
  fn: () => Promise<T>,
  opts: RetryTransientOptions = {},
): Promise<T> {
  const tries = opts.tries ?? 3;
  const maxMs = opts.maxMs ?? 5000;
  let delay = opts.startMs ?? 500;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= tries || !isTransientDbError(err)) throw err;
      const sleepMs = jitter(delay);
      recordDbTransientRetry(opts.label !== undefined ? { label: opts.label } : {});
      logger.warn({
        module: "db",
        action: "retry_transient",
        msg: "transient database error — retrying after backoff",
        ...(opts.label !== undefined ? { label: opts.label } : {}),
        attempt,
        tries,
        delay_ms: Math.round(sleepMs),
        ...errorFields(err),
      });
      await sleep(sleepMs);
      delay = Math.min(maxMs, delay * 2);
    }
  }
  throw lastErr;
}
