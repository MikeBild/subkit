// Anti-flake polling primitive shared by both test tracks.
//
// Research-backed rule: never `sleep(N)` and hope — poll a condition with
// a bounded deadline and exponential-ish backoff, then fail with a clear
// timeout. Every readiness / eventual-consistency wait in the e2e and
// docker suites funnels through `pollUntil` so there is exactly one place
// that owns the timeout/backoff contract.

/** Options for {@link pollUntil}. All durations are milliseconds. */
export interface PollOptions {
  /** Hard deadline before giving up. Default 30_000. */
  timeoutMs?: number;
  /** Initial delay between attempts. Default 250. */
  intervalMs?: number;
  /** Multiplier applied to the delay after each miss (capped). Default 1.5. */
  backoff?: number;
  /** Upper bound on a single delay so backoff never sleeps for minutes. Default 2_000. */
  maxIntervalMs?: number;
  /** Label used in the timeout error so failures are self-describing. */
  label?: string;
}

/**
 * Resolve once `fn` returns a truthy value (or a non-null object), polling
 * with backoff until the deadline. The resolved value is returned so callers
 * can both wait AND capture the thing they were waiting for in one step:
 *
 *   const exec = await pollUntil(() => fetchExecution(id), {
 *     label: `execution ${id} terminal`,
 *   });
 *
 * `fn` may be sync or async. A thrown error inside `fn` is treated as a miss
 * (swallowed and retried) so transient 404s / connection resets during
 * startup do not abort the poll — the deadline is the only thing that fails.
 */
export async function pollUntil<T>(
  fn: () => T | Promise<T>,
  opts: PollOptions = {},
): Promise<NonNullable<T>> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxIntervalMs = opts.maxIntervalMs ?? 2_000;
  const backoff = opts.backoff ?? 1.5;
  let interval = opts.intervalMs ?? 250;
  const label = opts.label ?? "condition";

  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const value = await fn();
      if (value !== undefined && value !== null && value !== false) {
        return value as NonNullable<T>;
      }
    } catch (err) {
      lastError = err;
    }
    // allow-wall-clock: bounded poll backoff — the only sleep pattern the
    // anti-flake guidance permits, gated by the deadline above.
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, maxIntervalMs)));
    interval = Math.min(interval * backoff, maxIntervalMs);
  }

  const suffix = lastError ? ` (last error: ${String(lastError)})` : "";
  throw new Error(
    `pollUntil timed out after ${timeoutMs}ms waiting for ${label} (${attempts} attempts)${suffix}`,
  );
}
