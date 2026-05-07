// Test-only conveniences over the production clock seam at
// `apps/engine/src/utils/clock.ts`. The override state lives there
// (single source of truth); this file adds the deterministic-clock
// builder and install/restore helpers tests use to freeze and advance
// time. Production code never imports from this barrel.
//
// Per #147 review S6: keeping `FROZEN_NOW`, `DeterministicClock`,
// `createDeterministicClock`, `installClock`, `restoreClock` here
// keeps the production surface narrow (just `now` / `setTestNow` /
// `getNowProvider`) and prevents an accidental production import of
// `createDeterministicClock` from widening the API surface.

import { getNowProvider, setTestNow } from "../../utils/clock.ts";

export {
  getNowProvider,
  type NowProvider,
  now,
  setTestNow,
} from "../../utils/clock.ts";

/** Fixed reference timestamp: 2023-11-14T22:13:20.000Z. Stable, in the
 *  past, round enough to read in logs. Tests use this as the default
 *  start for `createDeterministicClock`. */
export const FROZEN_NOW = 1_700_000_000_000;

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
export function installClock(
  clock: DeterministicClock,
): import("../../utils/clock.ts").NowProvider | null {
  const prev = getNowProvider();
  setTestNow(() => clock.now());
  return prev;
}

/** Restore a previously saved provider. Pass `null` to go back to real
 *  wall-clock. */
export function restoreClock(prev: import("../../utils/clock.ts").NowProvider | null): void {
  setTestNow(prev);
}

/** Legacy alias — same semantic as `now()`. New call-sites should use
 *  `now()` directly; the alias exists so existing test imports keep
 *  working without churn. */
export { now as getTestNow } from "../../utils/clock.ts";
