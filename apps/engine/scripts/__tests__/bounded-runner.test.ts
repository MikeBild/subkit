import { describe, expect, test } from "bun:test";
import { boundedConcurrency, runBoundedInOrder } from "../audit/bounded-runner.ts";

describe("bounded coverage runner", () => {
  test("caps concurrent work while retaining input order", async () => {
    let active = 0;
    let peak = 0;
    const output = await runBoundedInOrder([0, 1, 2, 3], 2, async (value) => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep((3 - value) * 2);
      active--;
      return `group-${value}`;
    });
    expect(peak).toBe(2);
    expect(output).toEqual(["group-0", "group-1", "group-2", "group-3"]);
  });

  test("waits for already-started work and does not schedule work after a failure", async () => {
    const started: number[] = [];
    let released = false;
    await expect(
      runBoundedInOrder([0, 1, 2], 2, async (value) => {
        started.push(value);
        if (value === 0) throw new Error("first group failed");
        await Bun.sleep(5);
        released = true;
        return value;
      }),
    ).rejects.toThrow("first group failed");
    expect(started).toEqual([0, 1]);
    expect(released).toBe(true);
  });

  test("fails closed when a task rejects with undefined", async () => {
    let rejected = false;
    try {
      await runBoundedInOrder([0, 1], 1, async (value) => {
        if (value === 0) return Promise.reject(undefined);
        return value;
      });
    } catch (error) {
      rejected = true;
      expect(error).toBeUndefined();
    }
    expect(rejected).toBe(true);
  });

  test("accepts only the documented environment range", () => {
    expect(boundedConcurrency(undefined)).toBe(2);
    expect(boundedConcurrency("1")).toBe(1);
    expect(boundedConcurrency("4")).toBe(4);
    expect(() => boundedConcurrency("0")).toThrow("1 through 4");
    expect(() => boundedConcurrency("5")).toThrow("1 through 4");
    expect(() => boundedConcurrency("two")).toThrow("1 through 4");
  });
});
