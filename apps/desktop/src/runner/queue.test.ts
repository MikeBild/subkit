import { describe, expect, test } from "bun:test";
import type { DeviceCommand, DeviceResult } from "@shared/device/protocol.ts";
import { command } from "../shared/local/runner-queue.fixture.ts";
import type { Settled } from "../shared/local/runner-queue.ts";
import { createRunnerQueue } from "./queue.ts";

function harness(execute: (command: DeviceCommand, signal: AbortSignal) => Promise<DeviceResult>) {
  const settled: Settled[] = [];
  const started: string[] = [];
  const queue = createRunnerQueue({
    execute: (item, signal) => {
      started.push(item.command_id);
      return execute(item, signal);
    },
    settle: (item) => settled.push(item),
    now: () => NOW,
  });
  return { queue, settled, started };
}

const NOW = Date.parse("2026-11-21T10:00:00.000Z");

function slow(_command: DeviceCommand, signal: AbortSignal): Promise<DeviceResult> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ status: "stopped" }));
  });
}

const soon = (ms: number) => new Date(NOW + ms).toISOString();

describe("createRunnerQueue", () => {
  test("runs commands one after another", async () => {
    const { queue, settled } = harness(async (item) => ({
      status: "done",
      output: item.command_id,
      evidence: {},
    }));
    queue.submit(command("a", { deadline_at: soon(5_000) }));
    queue.submit(command("b", { deadline_at: soon(5_000) }));
    await queue.idle();
    await queue.idle();
    expect(settled.map((item) => item.command_id)).toEqual(["a", "b"]);
  });

  test("after stop, no queued or later command runs", async () => {
    const { queue, settled, started } = harness(slow);
    queue.submit(command("a", { deadline_at: soon(10_000) }));
    queue.submit(command("b", { deadline_at: soon(10_000) }));
    queue.stop();
    await queue.idle();
    queue.submit(command("c", { deadline_at: soon(10_000) }));
    await queue.idle();
    expect(started).toEqual(["a"]);
    expect(settled).toEqual([
      { command_id: "b", result: { status: "stopped" } },
      { command_id: "a", result: { status: "stopped" } },
      {
        command_id: "c",
        result: {
          status: "refused",
          code: "stopped",
          detail: "The run was stopped on this device.",
        },
      },
    ]);
    expect(queue.generation()).toBe(1);
  });

  test("a restarted runner keeps refusing commands of a stopped generation", async () => {
    const settled: Settled[] = [];
    const queue = createRunnerQueue({
      generation: 1,
      execute: slow,
      settle: (item) => settled.push(item),
      now: () => NOW,
    });
    queue.submit(command("old", { deadline_at: soon(10_000), generation: 0 }));
    await queue.idle();
    expect(settled[0]?.result).toMatchObject({ status: "refused", code: "stopped" });
  });

  test("aborts a command at its deadline", async () => {
    const { queue, settled } = harness(slow);
    queue.submit(command("a", { deadline_at: soon(1) }));
    await queue.idle();
    expect(settled).toEqual([{ command_id: "a", result: { status: "stopped" } }]);
  });

  test("cancel aborts the running command", async () => {
    const { queue, settled } = harness(slow);
    queue.submit(command("a", { deadline_at: soon(10_000) }));
    queue.cancel("a");
    await queue.idle();
    expect(settled).toEqual([{ command_id: "a", result: { status: "stopped" } }]);
  });

  test("turns a thrown error into a failed result", async () => {
    const { queue, settled } = harness(async () => {
      throw new Error("boom");
    });
    queue.submit(command("a", { deadline_at: soon(5_000) }));
    await queue.idle();
    expect(settled[0]?.result).toEqual({ status: "failed", code: "runner_error", detail: "boom" });
  });
});
