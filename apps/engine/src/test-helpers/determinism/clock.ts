// Test-only conveniences over the production clock seam at
// `apps/engine/src/utils/clock.ts`. The override state lives there
// (single source of truth); this file adds the deterministic-clock
// builder and install/restore helpers tests use to freeze and advance
// time. Production code never imports from this barrel.
//
// The barrel deliberately does NOT re-export
// `now` (the production reader) so that a future production module
// can't silently depend on `test-helpers/` via this path — the import
// would have to reach across to `apps/engine/src/utils/clock.ts`
// directly, where the production surface lives. `setTestNow` and the
// `NowProvider` type are re-exported because tests legitimately
// install / type-name the provider; `getTestNow` is kept as a legacy
// alias to avoid churning ~50 existing test imports.

import { getNowProvider, setTestNow } from "../../utils/clock.ts";

export { type NowProvider, setTestNow } from "../../utils/clock.ts";

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
