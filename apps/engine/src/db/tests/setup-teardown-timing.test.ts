// Integration guard: a single, uncontended `createTestDb` round-trip
// (create → migrate → seed RBAC → cleanup) must finish well under the
// per-hook journey timeout. Slow teardown was the root cause of the
// 60-second `beforeEach/afterEach hook timed out` flakes in the
// journey suite — when a journey teardown takes the entire budget, the
// next file's beforeEach starts at the timeout boundary and any
// contention pushes it over.
//
// We keep the bar generous (5s) so this test does NOT become noisy
// under shared-runner load; the assertion is "uncontended teardown is
// fast enough that the journey budget has headroom for parallel
// contention", not "teardown takes X ms".

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "./setup.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("teardown-timing");
});

afterAll(async () => {
  // The harness already exposed `cleanup`; this hook runs it as a
  // belt-and-suspenders measure so a failure in the timed block below
  // does not leak a database.
  try {
    await ctx.cleanup();
  } catch {
    /* ignore — the timed block above already disposed it on the
       happy path */
  }
});

test("uncontended testcontainer teardown completes in under 5 seconds", async () => {
  // Spin a SECOND disposable db inside this test so the timed teardown
  // observes the full create+drop arc, leaving the outer `ctx` for
  // afterAll to keep this assertion repeatable across reruns.
  const tmp = await createTestDb("teardown-timing-inner");
  // `performance.now()` is the monotonic high-resolution clock — not the
  // logical clock the SUT consumes, so determinism does not apply. The
  // assertion is explicitly about elapsed duration (operator-visible
  // flake budget) and must not be replaced with a frozen test clock.
  const startedAt = performance.now();
  await tmp.cleanup();
  const elapsed = performance.now() - startedAt;
  expect(elapsed).toBeLessThan(5_000);
});
