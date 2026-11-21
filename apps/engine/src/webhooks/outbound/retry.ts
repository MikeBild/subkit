import { applyJitter } from "@shared/backoff.ts";

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  5 * 60 * 60_000,
  10 * 60 * 60_000,
  12 * 60 * 60_000,
  12 * 60 * 60_000,
  12 * 60 * 60_000,
  12 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;

let activeDelays: readonly number[] = DEFAULT_RETRY_DELAYS_MS;

export const RETRY_DELAYS_MS: ReadonlyArray<number> = new Proxy([] as number[], {
  get(_target, prop, _receiver) {
    if (prop === "length") return activeDelays.length;
    if (typeof prop === "string") {
      const idx = Number(prop);
      if (Number.isInteger(idx) && idx >= 0) return activeDelays[idx];
    }
    if (prop === Symbol.iterator) return activeDelays[Symbol.iterator].bind(activeDelays);
    const value = (activeDelays as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(activeDelays)
      : value;
  },
});

export function setRetryDelays(delays: readonly number[] | null): void {
  activeDelays = delays && delays.length > 0 ? [...delays] : DEFAULT_RETRY_DELAYS_MS;
}

export function getMaxAttempts(): number {
  return activeDelays.length + 1;
}

export function nextDelayMs(
  attemptNumber: number,
  opts?: { jitter?: boolean; random?: number },
): number | null {
  if (attemptNumber < 1) return null;
  if (attemptNumber > activeDelays.length) return null;
  const base = activeDelays[attemptNumber - 1];
  if (base === undefined) return null;
  if (opts?.jitter === false) return base;
  return Math.round(applyJitter(base, opts?.random ?? Math.random(), { symmetric: 0.1 }));
}
