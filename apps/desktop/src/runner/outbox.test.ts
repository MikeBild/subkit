import { describe, expect, test } from "bun:test";
import { createResultOutbox } from "./outbox.ts";

async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

function setup(failures: Record<string, number>) {
  const sent: string[] = [];
  const failed: unknown[] = [];
  const waits: number[] = [];
  let release: () => void = () => {};
  const outbox = createResultOutbox({
    deliver: async (commandId) => {
      sent.push(commandId);
      const left = failures[commandId] ?? 0;
      failures[commandId] = left - 1;
      if (left > 0) throw new TypeError("offline");
    },
    failed: (error) => failed.push(error),
    wait: (ms, signal) =>
      new Promise((resolve) => {
        waits.push(ms);
        release = () => resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    jitter: () => 0,
  });
  return { outbox, sent, failed, waits, release: () => release() };
}

describe("createResultOutbox", () => {
  test("delivers in order and retries a failed result before the next one", async () => {
    const rig = setup({ a: 1 });
    rig.outbox.add("a");
    rig.outbox.add("b");
    await settle();
    expect(rig.sent).toEqual(["a"]);
    expect(rig.failed).toHaveLength(1);
    rig.release();
    await settle();
    expect(rig.sent).toEqual(["a", "a", "b"]);
  });

  test("a wake ends the backoff at once", async () => {
    const rig = setup({ a: 1 });
    rig.outbox.add("a");
    await settle();
    rig.outbox.wake();
    await settle();
    expect(rig.sent).toEqual(["a", "a"]);
  });

  test("the same result is queued once", async () => {
    const rig = setup({ a: 1 });
    rig.outbox.add("a");
    rig.outbox.add("a");
    await settle();
    rig.release();
    await settle();
    rig.outbox.add("b");
    await settle();
    expect(rig.sent).toEqual(["a", "a", "b"]);
  });

  test("a closed outbox stops retrying", async () => {
    const rig = setup({ a: 5 });
    rig.outbox.add("a");
    await settle();
    rig.outbox.close();
    await settle();
    expect(rig.sent).toEqual(["a"]);
  });
});
