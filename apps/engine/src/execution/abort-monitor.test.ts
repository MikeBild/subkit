import { expect, test } from "bun:test";
import type { Db } from "../db/client.ts";
import { registerAbort, startAbortMonitor, unregisterAbort } from "./abort.ts";

test("abort monitor drains an already-started check and refuses new checks", async () => {
  const result = Promise.withResolvers<Array<{ id: string }>>();
  let reads = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          reads++;
          return result.promise;
        },
      }),
    }),
  } as unknown as Db;
  const id = "abort-drain";
  const controller = registerAbort(id, "tenant-drain");
  const monitor = startAbortMonitor(db, { intervalMs: () => 60_000 });
  try {
    const checking = monitor.checkNow();
    const stopping = monitor.stop();
    let drained = false;
    void stopping.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    await expect(monitor.checkNow()).rejects.toThrow("abort_monitor_stopped");
    result.resolve([{ id }]);
    expect(await checking).toBe(1);
    await stopping;
    expect(drained).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(reads).toBe(1);
  } finally {
    unregisterAbort(id);
    await monitor.stop();
  }
});

test("abort monitor stop propagates actual check failure", async () => {
  const result = Promise.withResolvers<Array<{ id: string }>>();
  const db = { select: () => ({ from: () => ({ where: () => result.promise }) }) } as unknown as Db;
  const id = "abort-failed-drain";
  registerAbort(id, "tenant-drain");
  const monitor = startAbortMonitor(db, { intervalMs: () => 60_000 });
  const checking = monitor.checkNow().catch((error: unknown) => error);
  const stopping = monitor.stop();
  result.reject(new Error("abort_check_failed"));
  try {
    await expect(stopping).rejects.toThrow("abort_check_failed");
    expect(await checking).toBeInstanceOf(Error);
  } finally {
    unregisterAbort(id);
  }
});
