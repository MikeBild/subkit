import { afterEach, describe, expect, test } from "bun:test";
import { instrument, sampleMemory } from "./runtime-telemetry.ts";

const realMemoryUsage = process.memoryUsage;

afterEach(() => {
  process.memoryUsage = realMemoryUsage;
});

const breakMemoryUsage = () => {
  process.memoryUsage = (() => {
    throw Object.assign(new Error("Failed to get memory usage"), {
      syscall: "memoryUsage",
      errno: 4,
    });
  }) as unknown as typeof process.memoryUsage;
};

describe("when the memory syscall fails", () => {
  test("instrument still returns the wrapped result", async () => {
    breakMemoryUsage();
    const result = await instrument({
      module: "test",
      action: "test.op",
      memory: true,
      fn: () => "the work completed",
    });
    expect(result).toBe("the work completed");
  });

  test("and a failing operation still throws ITS OWN error, not the telemetry one", async () => {
    breakMemoryUsage();
    const failing = instrument({
      module: "test",
      action: "test.op",
      memory: true,
      fn: () => {
        throw new Error("the real failure");
      },
    });
    await expect(failing).rejects.toThrow("the real failure");
  });

  test("sampleMemory reports zeroes rather than throwing", () => {
    breakMemoryUsage();
    expect(sampleMemory()).toEqual({
      rss_mb: 0,
      heap_used_mb: 0,
      heap_total_mb: 0,
      external_mb: 0,
      array_buffers_mb: 0,
    });
  });

  test("and a healthy process still reports a real reading", () => {
    expect(sampleMemory().rss_mb).toBeGreaterThan(0);
  });
});
