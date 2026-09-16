import { expect, test } from "bun:test";
import { type ReconcilerOptions, SchedulerReconciler } from "../reconciler.ts";

test("stop drains an already-started timer callback before database shutdown", async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  class Probe extends SchedulerReconciler {
    override async reconcileOnce() {
      if (++calls === 1) return;
      entered();
      await blocked;
    }
  }
  const reconciler = new Probe({ intervalMs: 5 } as ReconcilerOptions);
  await reconciler.start();
  await running;
  let stopped = false;
  const stopping = reconciler.stop().then(() => {
    stopped = true;
  });
  try {
    await Bun.sleep(20);
    expect(stopped).toBe(false);
    expect(calls).toBe(2);
  } finally {
    release();
    await stopping;
  }
  expect(stopped).toBe(true);
});
