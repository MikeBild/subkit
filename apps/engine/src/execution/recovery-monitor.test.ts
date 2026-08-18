import { describe, expect, test } from "bun:test";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { startCrashRecoveryMonitor } from "./recovery.ts";

describe("startCrashRecoveryMonitor", () => {
  test("keeps recovery single-flight and re-reads the interval between passes", async () => {
    let recoverCalls = 0;
    let intervalReads = 0;
    let releaseFirst: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const monitor = startCrashRecoveryMonitor({} as never, {
      intervalMs: () => {
        intervalReads += 1;
        return 5;
      },
      recover: async () => {
        recoverCalls += 1;
        if (recoverCalls === 1) await first;
        return { recovered: 0 };
      },
    });

    try {
      const a = monitor.checkNow();
      const b = monitor.checkNow();
      expect(recoverCalls).toBe(1);
      releaseFirst();
      await Promise.all([a, b]);
      await waitFor(() => recoverCalls >= 2, {
        tries: 100,
        sleepMs: 1,
        label: "periodic recovery pass",
      });
      expect(intervalReads).toBeGreaterThanOrEqual(2);
    } finally {
      monitor.stop();
    }
  });
});
