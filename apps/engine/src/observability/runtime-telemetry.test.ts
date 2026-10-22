import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DomainRefusal } from "../logging/domain-refusal.ts";
import { logger } from "../logging/logger.ts";
import { instrument, sampleMemory } from "./runtime-telemetry.ts";

describe("when an instrumented operation is rejected", () => {
  const reject = (error: unknown) =>
    instrument({
      module: "db",
      action: "transaction",
      fn: () => {
        throw error;
      },
    }).catch((caught: unknown) => caught);

  test("a deliberate domain refusal logs a debug refusal and no failure warning", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const refusal = new DomainRefusal(
        "execution_authority_required",
        "this workflow requires concrete-run review for its current effects",
      );
      expect(await reject(refusal)).toBe(refusal);
      expect(warn).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug.mock.calls[0]?.[0]).toMatchObject({
        module: "db",
        action: "transaction.refused",
        outcome: "refused",
        reason_code: "execution_authority_required",
      });
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
  });

  test("plain and database errors still warn as failures", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await reject(new Error("queue unavailable"));
      await reject(Object.assign(new Error("relation missing"), { code: "42P01" }));
      await reject(
        Object.assign(new Error("requires concrete-run review"), {
          code: "execution_authority_required",
        }),
      );
      expect(warn).toHaveBeenCalledTimes(3);
      for (const call of warn.mock.calls)
        expect(call[0]).toMatchObject({ action: "transaction.failed", outcome: "error" });
    } finally {
      warn.mockRestore();
    }
  });
});

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
