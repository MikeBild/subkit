// Production clock seam. Services that need to read "now" call `now()`
// from this module instead of `Date.now()` directly. Tests install a
// deterministic source via `setTestNow(...)` so timestamps are
// reproducible across runs without per-call dependency injection.
//
// Production behaviour: when no override is installed, `now()` returns
// `Date.now()`. The override slot is module-local — there is exactly
// one source of test-overridable wall-clock time in the engine, and the
// determinism lint at `scripts/check-determinism.ts` blocks ad-hoc
// `Date.now()` / `new Date()` calls in tests.
//
// Layering: test-only conveniences (`FROZEN_NOW`, `createDeterministicClock`,
// `installClock`, `restoreClock`, the `getTestNow` alias) live in
// `apps/engine/src/test-helpers/determinism/clock.ts` and consume the
// `setTestNow` / `getNowProvider` writers exported here. Production
// code never imports from `test-helpers/`.

export type NowProvider = () => number;

let nowOverride: NowProvider | null = null;

/** Read the current wall-clock time. Honours an installed test
 *  override; otherwise falls back to `Date.now()`. */
export function now(): number {
  // allow-wall-clock: this IS the seam — every other production
  // module reads time through `now()` from this file. A future
  // "scrub all Date.now()" sweep must leave this single call in
  // place; the override slot above is what makes determinism tests
  // deterministic in the first place.
  return nowOverride ? nowOverride() : Date.now();
}

/** Install (or clear with `null`) a test override for `now()`. Tests
 *  call this via `installClock(...)` or directly; production code
 *  never invokes it. */
export function setTestNow(provider: NowProvider | null): void {
  nowOverride = provider;
}

/**
 * Snapshot the current override; lets test setups stack and restore.
 *
 * @internal Production code never reads the override slot — the
 *   sole legitimate consumers are `installClock` / `restoreClock` in
 *   `apps/engine/src/test-helpers/determinism/clock.ts`. The
 *   `@internal` tag flags any future production import for review.
 */
export function getNowProvider(): NowProvider | null {
  return nowOverride;
}
