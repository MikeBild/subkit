// Unit coverage for the shared runtime-telemetry primitives. Logs are
// captured by intercepting process.stdout.write (ndjson mode) so the test
// sees the exact bytes an operator's log pipeline would.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { _resetLoggerForTests, reconfigureLogger } from "../../logging/logger.ts";
import {
  bootPhase,
  instrument,
  sampleMemory,
  startBootHeartbeat,
  startEventLoopLagMonitor,
  startMemorySampler,
} from "../runtime-telemetry.ts";

interface CapturedLog {
  module?: string;
  action?: string;
  outcome?: string;
  duration_ms?: number;
  [k: string]: unknown;
}

let captured: CapturedLog[];
let restoreStdout: () => void;

function byAction(action: string): CapturedLog[] {
  return captured.filter((l) => l.action === action);
}

beforeEach(() => {
  captured = [];
  reconfigureLogger({ format: "ndjson", level: "debug" });
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const line of s.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        captured.push(JSON.parse(trimmed) as CapturedLog);
      } catch {
        /* not a json line */
      }
    }
    return true;
  }) as typeof process.stdout.write;
  restoreStdout = () => {
    process.stdout.write = orig;
  };
});

afterEach(() => {
  restoreStdout();
  _resetLoggerForTests();
});

describe("sampleMemory", () => {
  test("returns a numeric MB snapshot with all fields", () => {
    const snap = sampleMemory();
    for (const key of [
      "rss_mb",
      "heap_used_mb",
      "heap_total_mb",
      "external_mb",
      "array_buffers_mb",
    ] as const) {
      expect(typeof snap[key]).toBe("number");
      expect(Number.isFinite(snap[key])).toBe(true);
      expect(snap[key]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("instrument", () => {
  test("success: returns the value and logs <action>.completed with numeric duration", async () => {
    const result = await instrument({
      module: "test",
      action: "widget.build",
      fields: { widget_id: "w1" },
      fn: () => 42,
    });
    expect(result).toBe(42);
    const done = byAction("widget.build.completed");
    expect(done).toHaveLength(1);
    expect(done[0]?.module).toBe("test");
    expect(done[0]?.outcome).toBe("ok");
    expect(typeof done[0]?.duration_ms).toBe("number");
    expect(done[0]?.widget_id).toBe("w1");
    // No failure line on the happy path.
    expect(byAction("widget.build.failed")).toHaveLength(0);
  });

  test("awaits async fns and threads the resolved value", async () => {
    const result = await instrument({
      module: "test",
      action: "async.op",
      fn: async () => "done",
    });
    expect(result).toBe("done");
    expect(byAction("async.op.completed")).toHaveLength(1);
  });

  test("failure: logs <action>.failed with error fields and re-throws", async () => {
    await expect(
      instrument({
        module: "test",
        action: "widget.break",
        fn: () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    const failed = byAction("widget.break.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.outcome).toBe("error");
    expect(failed[0]?.error).toBe("boom");
    expect(typeof failed[0]?.duration_ms).toBe("number");
    expect(byAction("widget.break.completed")).toHaveLength(0);
  });

  test("memory:true attaches rss_mb and rss_delta_mb", async () => {
    await instrument({ module: "test", action: "heavy.op", memory: true, fn: () => 1 });
    const done = byAction("heavy.op.completed");
    expect(done).toHaveLength(1);
    expect(typeof done[0]?.rss_mb).toBe("number");
    expect(typeof done[0]?.rss_delta_mb).toBe("number");
  });

  test("thresholdMs suppresses the success log for fast ops but still returns", async () => {
    const result = await instrument({
      module: "test",
      action: "fast.op",
      // No real op exceeds this synchronously; the success log is suppressed.
      thresholdMs: 3_600_000,
      fn: () => "ok",
    });
    expect(result).toBe("ok");
    expect(byAction("fast.op.completed")).toHaveLength(0);
  });
});

describe("bootPhase", () => {
  test("emits start then ok markers carrying the phase name + duration", async () => {
    const result = await bootPhase("config_load", async () => "loaded");
    expect(result).toBe("loaded");
    const phases = byAction("phase").filter(
      (l) => l.module === "boot" && l.phase === "config_load",
    );
    const start = phases.find((l) => l.status === "start");
    const ok = phases.find((l) => l.status === "ok");
    expect(start).toBeDefined();
    expect(ok).toBeDefined();
    expect(typeof ok?.duration_ms).toBe("number");
  });

  test("emits an error marker and re-throws on failure", async () => {
    await expect(
      bootPhase("migrations", () => {
        throw new Error("migrate failed");
      }),
    ).rejects.toThrow("migrate failed");
    const err = byAction("phase").find(
      (l) => l.module === "boot" && l.phase === "migrations" && l.status === "error",
    );
    expect(err).toBeDefined();
    expect(err?.error).toBe("migrate failed");
  });
});

describe("samplers", () => {
  test("startMemorySampler fires one immediate sample and stops cleanly", () => {
    const stop = startMemorySampler({ intervalMs: 3_600_000 });
    try {
      const samples = byAction("memory.sample").filter((l) => l.module === "process");
      expect(samples.length).toBeGreaterThanOrEqual(1);
      expect(typeof samples[0]?.rss_mb).toBe("number");
    } finally {
      stop();
    }
    expect(typeof stop).toBe("function");
  });

  test("startEventLoopLagMonitor and startBootHeartbeat return working stop fns", () => {
    const stopLag = startEventLoopLagMonitor({ intervalMs: 3_600_000 });
    const stopBeat = startBootHeartbeat({ intervalMs: 3_600_000 });
    expect(typeof stopLag).toBe("function");
    expect(typeof stopBeat).toBe("function");
    // Stopping must never throw.
    expect(() => {
      stopLag();
      stopBeat();
    }).not.toThrow();
  });
});
