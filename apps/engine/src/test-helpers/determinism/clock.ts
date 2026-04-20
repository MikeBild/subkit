// Deterministic clock primitives for tests.
//
// Production code that needs "now" should either accept an injected
// Clock or call `getTestNow()`. Tests install a deterministic source
// via `setTestNow` so timestamps are reproducible across runs.
//
// Pattern borrowed from /Users/mikebild/Projects/AI/tacktics/src/__integration__/setup/timeHelpers.ts

/** Fixed reference timestamp: 2023-11-14T22:13:20.000Z. Chosen so it's
 *  stable, in the past, and round enough to read in logs. */
export const FROZEN_NOW = 1_700_000_000_000;

export type NowProvider = () => number;

let nowOverride: NowProvider | null = null;

export function setTestNow(provider: NowProvider | null): void {
  nowOverride = provider;
}

export function getTestNow(): number {
  return nowOverride ? nowOverride() : Date.now();
}

export interface DeterministicClock {
  now(): number;
  advanceBy(ms: number): number;
  setTo(value: number): number;
}

export function createDeterministicClock(start: number = FROZEN_NOW): DeterministicClock {
  let current = start;
  return {
    now: () => current,
    advanceBy: (ms: number) => {
      current += ms;
      return current;
    },
    setTo: (value: number) => {
      current = value;
      return current;
    },
  };
}

/** Install `clock` as the global test-now source. Returns the previous
 *  provider so callers can restore on teardown. */
export function installClock(clock: DeterministicClock): NowProvider | null {
  const prev = nowOverride;
  setTestNow(() => clock.now());
  return prev;
}

/** Restore a previously saved provider. Pass `null` to go back to
 *  real wall-clock. */
export function restoreClock(prev: NowProvider | null): void {
  setTestNow(prev);
}
