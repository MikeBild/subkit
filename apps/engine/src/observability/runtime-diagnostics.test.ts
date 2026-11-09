import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../logging/logger.ts";
import {
  diagnoseOperation,
  runtimeDiagnosticOptions,
  runtimeDiagnosticsEnabled,
} from "./runtime-diagnostics.ts";

const originalEnv = {
  enabled: process.env.SUBKIT_DIAGNOSTICS,
  interval: process.env.SUBKIT_DIAGNOSTICS_INTERVAL_MS,
  max: process.env.SUBKIT_DIAGNOSTICS_MAX_SAMPLES,
};

afterEach(() => {
  if (originalEnv.enabled === undefined) delete process.env.SUBKIT_DIAGNOSTICS;
  else process.env.SUBKIT_DIAGNOSTICS = originalEnv.enabled;
  if (originalEnv.interval === undefined) delete process.env.SUBKIT_DIAGNOSTICS_INTERVAL_MS;
  else process.env.SUBKIT_DIAGNOSTICS_INTERVAL_MS = originalEnv.interval;
  if (originalEnv.max === undefined) delete process.env.SUBKIT_DIAGNOSTICS_MAX_SAMPLES;
  else process.env.SUBKIT_DIAGNOSTICS_MAX_SAMPLES = originalEnv.max;
});

describe("runtime diagnostics", () => {
  test("remain disabled unless explicitly opted in", async () => {
    delete process.env.SUBKIT_DIAGNOSTICS;
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      expect(runtimeDiagnosticsEnabled()).toBe(false);
      await diagnoseOperation({ action: "db.transaction", fn: async () => 7 });
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  test("logs only duration and pool counts, never query arguments", async () => {
    process.env.SUBKIT_DIAGNOSTICS = "1";
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      await diagnoseOperation({
        action: "boss.query",
        pool: "boss",
        poolCounts: () => ({ total: 2, idle: 1, waiting: 0, max: 10 }),
        fn: async () => "ignored query result",
      });
      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0]?.[0]).toMatchObject({
        module: "diagnostics",
        action: "boss.query.completed",
        boss_pool_total: 2,
        boss_pool_idle: 1,
        boss_pool_waiting: 0,
        boss_pool_max: 10,
      });
      expect(JSON.stringify(info.mock.calls[0]?.[0])).not.toContain("ignored query result");
    } finally {
      info.mockRestore();
    }
  });

  test("clamps diagnostic sampling configuration", () => {
    process.env.SUBKIT_DIAGNOSTICS_INTERVAL_MS = "1";
    process.env.SUBKIT_DIAGNOSTICS_MAX_SAMPLES = "999999";
    expect(runtimeDiagnosticOptions()).toEqual({ interval_ms: 250, max_samples: 3600 });
  });
});
