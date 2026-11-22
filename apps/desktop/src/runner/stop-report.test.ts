import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import type { DeviceStopReport } from "@shared/device/protocol.ts";
import { abortableWait, createStopReporter } from "./stop-report.ts";

const at = (generation: number): DeviceStopReport => ({
  generation,
  stopped_at: "2026-11-21T10:00:00.000Z",
});

function setup(failures: number) {
  const sent: number[] = [];
  const acked: number[] = [];
  const waits: number[] = [];
  let left = failures;
  const reporter = createStopReporter({
    send: async (report) => {
      sent.push(report.generation);
      if (left-- > 0) throw new Error("offline");
    },
    acknowledged: (generation) => acked.push(generation),
    wait: async (ms) => {
      waits.push(ms);
    },
    jitter: () => 0,
  });
  return { reporter, sent, acked, waits };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

describe("createStopReporter", () => {
  test("retries with backoff until the server acknowledges", async () => {
    const { reporter, sent, acked, waits } = setup(2);
    reporter.report(at(3));
    await settle();
    expect(sent).toEqual([3, 3, 3]);
    expect(acked).toEqual([3]);
    expect(waits).toHaveLength(2);
    expect(waits[1]).toBeGreaterThanOrEqual(waits[0] ?? 0);
  });

  test("ignores an older report than the one in flight", async () => {
    const { reporter, sent, acked } = setup(0);
    reporter.report(at(5));
    reporter.report(at(4));
    await settle();
    expect(sent).toEqual([5]);
    expect(acked).toEqual([5]);
  });

  test("stops retrying once closed", async () => {
    const { reporter, sent } = setup(100);
    reporter.close();
    reporter.report(at(1));
    await settle();
    expect(sent).toEqual([]);
  });
});

describe("abortableWait", () => {
  test("ends early on abort", async () => {
    const controller = new AbortController();
    const waiting = abortableWait(60_000, controller.signal);
    controller.abort();
    expect(await waiting).toBeUndefined();
  });

  test("frees the abort listener of every wait that runs out", async () => {
    const controller = new AbortController();
    for (let wait = 0; wait < 50; wait += 1) await abortableWait(0, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
