import { describe, expect, test } from "bun:test";
import { runJs } from "../runtime.ts";
import { DEFAULT_LIMITS } from "../types.ts";

async function ticksFor(code: string): Promise<number> {
  const { stats } = await runJs({ code, input: null, clock: null });
  return stats.ticks;
}

describe("opcode-tick calibration", () => {
  test("large workloads accumulate ticks", async () => {
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
    const ticks = await ticksFor(`
      var arr = [];
      for (var i = 0; i < 500; i++) arr.push({ i: i, label: 'row-' + i });
      var total = arr.reduce(function (acc, x) { return acc + x.i; }, 0);
      return total;
    `);
    expect(ticks).toBeLessThan(DEFAULT_LIMITS.tick_budget / 10);
  });

  test("default budget safely exceeds a realistic hook workload", async () => {
    const { stats } = await runJs({
      code: `
        var m = (input.request && input.request.method) || "";
        if (m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE") {
          return { allow: false, reason: "mutating_denied" };
        }
        return { allow: true };
      `,
      input: { request: { method: "POST" } },
      limits: { tick_budget: 100_000, wall_ms: 2_000 },
      clock: null,
    });
    expect(stats.ticks).toBeLessThan(100_000 / 100);
  });
});
