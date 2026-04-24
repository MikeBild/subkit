// Tick-calibration tests. The interrupt handler fires between basic
// blocks, not per opcode, so the "opcode_budget" is really a tick
// budget. These tests exercise workloads of known structure and
// assert that:
//
//   1. Tick counts scale with workload size (monotonicity).
//   2. Realistic user workloads complete well below the
//      DEFAULT_LIMITS.opcode_budget, i.e. the default is not so
//      tight that normal code trips it.
//
// Numbers printed via `stats.opcode_ticks` are informational: if the
// interrupt cadence of QuickJS changes in a future version, this test
// makes the shift visible and tells us whether `TICKS_PER_OPCODE_BATCH`
// needs to be retuned.

import { describe, expect, test } from "bun:test";
import { runJs } from "../runtime.ts";
import { DEFAULT_LIMITS } from "../types.ts";

async function ticksFor(code: string): Promise<number> {
  const { stats } = await runJs({ code, input: null });
  return stats.opcode_ticks;
}

describe("opcode-tick calibration", () => {
  test("large workloads accumulate ticks", async () => {
    // Tight inner loops elide interrupt-handler firings, so we use a
    // workload big enough to cross multiple interrupt boundaries.
    // We assert that the very-large workload produces more ticks
    // than the small one — the exact ratio depends on QuickJS
    // internals and is not what we are pinning.
    const small = await ticksFor(`
      var arr = [];
      for (var i = 0; i < 100; i++) arr.push({ i: i });
      return arr.length;
    `);
    const large = await ticksFor(`
      var arr = [];
      for (var i = 0; i < 10000; i++) arr.push({ i: i, s: 'row-' + i });
      return arr.length;
    `);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
  });

  test("realistic transform workload fits inside the default budget", async () => {
    // 500 object allocations + a reduce — representative of a
    // transform step. Must consume a small fraction of the default
    // opcode_budget (10M). If this starts failing, the interrupt
    // cadence has tightened and TICKS_PER_OPCODE_BATCH needs to drop.
    const ticks = await ticksFor(`
      var arr = [];
      for (var i = 0; i < 500; i++) arr.push({ i: i, label: 'row-' + i });
      var total = arr.reduce(function (acc, x) { return acc + x.i; }, 0);
      return total;
    `);
    expect(ticks).toBeLessThan(DEFAULT_LIMITS.opcode_budget / 10);
  });

  test("default budget safely exceeds a realistic hook workload", async () => {
    // A representative before-request-hook workload: navigate input,
    // check an HTTP method list, return a decision. Must complete
    // well under the tight hook budget (100k).
    const { stats } = await runJs({
      code: `
        var m = (input.request && input.request.method) || "";
        if (m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE") {
          return { allow: false, reason: "mutating_denied" };
        }
        return { allow: true };
      `,
      input: { request: { method: "POST" } },
      limits: { opcode_budget: 100_000, wall_ms: 2_000 },
    });
    // Realistic hook runs should come in well under 1 % of the hook budget.
    expect(stats.opcode_ticks).toBeLessThan(100_000 / 100);
  });
});
