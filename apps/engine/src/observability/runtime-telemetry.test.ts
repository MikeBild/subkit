// Telemetry must not be able to break what it measures.
import { afterEach, describe, expect, test } from "bun:test";
import { instrument, sampleMemory } from "./runtime-telemetry.ts";

const realMemoryUsage = process.memoryUsage;

afterEach(() => {
  process.memoryUsage = realMemoryUsage;
});

/**
 * `process.memoryUsage()` is a syscall and it can fail. A CI runner returned
 * `SystemError: Failed to get memory usage, errno: 4` (EINTR) from inside
 * `instrument()`; it propagated out of a transform step and failed the workflow
 * that step belonged to — a workflow whose only crime was being measured.
 */
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
    // The dangerous regression is not "it throws" — it is throwing the WRONG
    // error, which would send whoever reads the log after a memory problem
    // instead of the failure that actually happened.
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
    // Zero is visibly wrong in a dashboard, which is how a missing measurement
    // should look. Plausible-but-invented numbers would be worse.
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
