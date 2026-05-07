// Production clock seam. Services that need to read "now" call `now()`
// from this module instead of `Date.now()` directly. Tests install a
// deterministic source via `setTestNow(...)` (or `installClock(...)`
// from test-helpers/determinism) so timestamps are reproducible across
// runs without per-call dependency injection.
//
// Production behaviour: when no override is installed, `now()` returns
// `Date.now()`. The override slot is module-local — there is exactly
// one source of test-overridable wall-clock time in the engine, and the
// determinism lint at `scripts/check-determinism.ts` blocks ad-hoc
// `Date.now()` / `new Date()` calls in tests.

export type NowProvider = () => number;

/** Fixed reference timestamp: 2023-11-14T22:13:20.000Z. Stable, in the
 *  past, round enough to read in logs. Tests use this as the default
 *  start for `createDeterministicClock`. */
export const FROZEN_NOW = 1_700_000_000_000;

let nowOverride: NowProvider | null = null;

/** Read the current wall-clock time. Honours an installed test
 *  override; otherwise falls back to `Date.now()`. */
export function now(): number {
  return nowOverride ? nowOverride() : Date.now();
}

/** Install (or clear with `null`) a test override for `now()`. */
export function setTestNow(provider: NowProvider | null): void {
  nowOverride = provider;
}

/** Snapshot the current override; lets test setups stack and restore. */
export function getNowProvider(): NowProvider | null {
  return nowOverride;
}

/** Legacy alias: same semantic as `now()`. New call-sites should use
 *  `now()`; the alias exists so existing test imports keep working. */
export function getTestNow(): number {
  return now();
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

/** Install `clock` as the global "now" source. Returns the previous
 *  provider so callers can restore on teardown. */
export function installClock(clock: DeterministicClock): NowProvider | null {
  const prev = nowOverride;
  setTestNow(() => clock.now());
  return prev;
}

/** Restore a previously saved provider. Pass `null` to go back to real
 *  wall-clock. */
export function restoreClock(prev: NowProvider | null): void {
  setTestNow(prev);
}
