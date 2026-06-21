// Transient-database-error detection + a bounded retry wrapper.
//
// When PostgreSQL is briefly unreachable — a point-release restart by
// unattended-upgrades, a failover, a momentary network blip — every
// in-flight query throws. The pub/sub listener already survives this with
// exponential-backoff reconnects (see pubsub/listener.ts); the scheduler did
// NOT, so a 10-second bounce dropped a whole reconcile tick and parked
// per-cadence jobs for 1–6 hours. `retryTransient` lets a caller absorb the
// bounce within the same tick.
//
// Detection matches DOCUMENTED signals only — never free-text guessing — in
// the same spirit as connectors/drivers/probe-classify.ts:
//   - libpq / Node system error codes on `err.code`
//   - the two node-postgres connection-teardown messages that carry NO code
//
// A NON-transient error (a real query bug, a constraint violation) must fall
// through immediately so we never mask logic errors behind retries.

import { errorFields, logger } from "../logging/logger.ts";

/**
 * SQLSTATE + Node system codes that mean "the connection went away / the
 * server is not accepting connections right now", i.e. retrying may succeed.
 *
 *   ECONNREFUSED / ECONNRESET / ETIMEDOUT / EPIPE — Node socket errors raised
 *     when the server is down or the socket was torn down mid-query.
 *   57P01 admin_shutdown            — "terminating connection due to administrator command"
 *   57P02 crash_shutdown
 *   57P03 cannot_connect_now        — server is starting up / shutting down
 *   08000 connection_exception
 *   08001 sqlclient_unable_to_establish_sqlconnection
 *   08003 connection_does_not_exist
 *   08006 connection_failure
 * SQLSTATE reference: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
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
]);

/**
 * node-postgres surfaces a socket close that races a query as a plain Error
 * with NO `.code`. Match these two canonical messages so the codeless
 * "connection died" case is still treated as transient. Exact-substring, not
 * a fuzzy keyword scan.
 */
const TRANSIENT_MESSAGES = [
  "Connection terminated unexpectedly",
  "terminating connection due to administrator command",
  "Client has encountered a connection error and is not queryable",
];

/**
 * True when `err` looks like a momentary connectivity failure that a retry
 * could clear. Defensive against null / non-Error shapes (never throws).
 */
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
  /** Total attempts including the first. Default 3. */
  tries?: number;
  /** First backoff delay in ms; doubles each retry. Default 500. */
  startMs?: number;
  /** Cap on the backoff delay. Default 5000. */
  maxMs?: number;
  /** Label for the retry log line, e.g. the reconcile pass name. */
  label?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ±20% jitter so independent retriers (multiple engine instances, or several
// reconcile passes) recovering from the SAME bounce don't realign on one
// backoff schedule and stampede the just-returned database. Matches the
// request-step retry's jitter (execution/steps/request/retry.ts).
function jitter(ms: number): number {
  return Math.max(0, ms + (Math.random() * 2 - 1) * ms * 0.2);
}

/**
 * Run `fn`, retrying ONLY on `isTransientDbError` with capped exponential
 * backoff + jitter (mirrors the pub/sub listener: start small, double, cap). A
 * non-transient error rethrows immediately; the last transient error rethrows
 * once `tries` is exhausted so the caller's existing `.catch()` logging fires.
 *
 * IDEMPOTENCY CONTRACT: `fn` MUST be safe to run more than once. retryTransient
 * cannot detect a partial commit — if `fn` performs an enqueue/write and THEN
 * advances a dedup watermark, a transient connection drop between the two will
 * re-run the whole body on retry and double-fire. Every scheduler pass wrapped
 * here advances its CAS/`last_enqueued_at` watermark such that a re-run is a
 * no-op (the cron-due / claim check fails the second time); keep that order
 * when adding new callers.
 */
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
  // Unreachable: the loop either returns or throws. Satisfies the type checker.
  throw lastErr;
}
