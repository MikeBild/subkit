// P11 retry ladder.
//
// Stripe-style: aggressive at first, then a long 12h tail that bounds
// the total retry window to roughly three days. The ladder is static
// so tests can assert the exact sequence. Jitter is applied at ±10%
// unless the caller opts out.

/**
 * Default delay (ms) between attempt N and attempt N+1, where index 0
 * is the delay before the FIRST retry (i.e. after the initial attempt
 * fails).
 *
 *   1m, 5m, 30m, 2h, 5h, 10h, 12h × 5
 *
 * The active ladder is mutable so tests can shrink it via
 * `setRetryDelays([5, 5, 5])`. Production code never mutates it. The
 * array is exported by reference; callers that need to compare against
 * the spec values should copy it first.
 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [
  60_000, // 1 min
  5 * 60_000, // 5 min
  30 * 60_000, // 30 min
  2 * 60 * 60_000, // 2 hours
  5 * 60 * 60_000, // 5 hours
  10 * 60 * 60_000, // 10 hours
  12 * 60 * 60_000, // 12 hours
  12 * 60 * 60_000,
  12 * 60 * 60_000,
  12 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;

// Mutable backing array. Exposed via the `RETRY_DELAYS_MS` getter
// below so tests can swap the ladder out wholesale via
// `setRetryDelays(...)`. We do NOT export the variable directly because
// `let` exports cannot be reassigned across module boundaries in some
// TS settings; the getter sidesteps that.
let activeDelays: readonly number[] = DEFAULT_RETRY_DELAYS_MS;

export const RETRY_DELAYS_MS: ReadonlyArray<number> = new Proxy([] as number[], {
  get(_target, prop, _receiver) {
    if (prop === "length") return activeDelays.length;
    if (typeof prop === "string") {
      const idx = Number(prop);
      if (Number.isInteger(idx) && idx >= 0) return activeDelays[idx];
    }
    if (prop === Symbol.iterator) return activeDelays[Symbol.iterator].bind(activeDelays);
    // Reflect any other Array.prototype reads (forEach, map, etc.) onto
    // the active backing array so consumers can treat the proxy as a
    // normal readonly array.
    const value = (activeDelays as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(activeDelays)
      : value;
  },
});

/**
 * Replace the active retry ladder. Pass `null` (or omit) to restore the
 * production defaults. Intended for tests only.
 */
export function setRetryDelays(delays: readonly number[] | null): void {
  activeDelays = delays && delays.length > 0 ? [...delays] : DEFAULT_RETRY_DELAYS_MS;
}

export function getMaxAttempts(): number {
  return activeDelays.length + 1;
}

/** Backwards-compat constant used by the production webhook delivery
 * worker. Equal to `getMaxAttempts()` evaluated at import time against
 * the default ladder. New code should call `getMaxAttempts()` so it
 * picks up test-time overrides. */
export const MAX_ATTEMPTS = DEFAULT_RETRY_DELAYS_MS.length + 1;

/**
 * Compute the next delay, in milliseconds, given the number of
 * ALREADY-COMPLETED attempts. `attemptNumber` is 1-based:
 *   attemptNumber = 1 → returned delay is RETRY_DELAYS_MS[0]
 *   attemptNumber = activeDelays.length + 1 → returns null (give up)
 */
export function nextDelayMs(
  attemptNumber: number,
  opts?: { jitter?: boolean; clock?: () => number },
): number | null {
  if (attemptNumber < 1) return null;
  if (attemptNumber > activeDelays.length) return null;
  const base = activeDelays[attemptNumber - 1];
  if (base === undefined) return null;
  const jitter = opts?.jitter !== false;
  if (!jitter) return base;
  // ±10% jitter, uniformly sampled.
  const span = base * 0.1;
  const delta = (Math.random() * 2 - 1) * span;
  return Math.max(0, Math.round(base + delta));
}

export function isTerminalAttempt(attemptNumber: number): boolean {
  return attemptNumber >= getMaxAttempts();
}
