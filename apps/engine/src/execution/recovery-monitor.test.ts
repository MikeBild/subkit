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
        return { recovered: 0, reconciled_steps: 0 };
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
      await monitor.stop();
    }
  });
});

test("recovery shutdown holds the active check and refuses later admission", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const monitor = startCrashRecoveryMonitor({} as never, {
    intervalMs: () => 60_000,
    recover: async () => {
      calls++;
      entered.resolve();
      await release.promise;
      return { recovered: 0, reconciled_steps: 0 };
    },
  });
  const checking = monitor.checkNow();
  await entered.promise;
  const stopping = monitor.stop();
  let stopped = false;
  void stopping.then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  await expect(monitor.checkNow()).rejects.toThrow("crash_recovery_monitor_stopped");
  release.resolve();
  await checking;
  await stopping;
  await monitor.stop();
  expect(stopped).toBe(true);
  expect(calls).toBe(1);
});

test("recovery shutdown propagates actual check failure", async () => {
  const release = Promise.withResolvers<void>();
  const monitor = startCrashRecoveryMonitor({} as never, {
    intervalMs: () => 60_000,
    recover: () =>
      release.promise.then(() => {
        throw new Error("recovery_check_failed");
      }),
  });
  const checking = monitor.checkNow();
  const observed = checking.catch((error: unknown) => error);
  const stopping = monitor.stop();
  release.resolve();
  await expect(stopping).rejects.toThrow("recovery_check_failed");
  expect(await observed).toBeInstanceOf(Error);
});
