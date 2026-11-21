import { describe, expect, test } from "bun:test";
import type { Settled } from "../../shared/local/runner-queue.ts";
import { createRunnerQueue } from "../queue.ts";
import { APPS, command, DEVICE, NOW, ON, snap, windows } from "./driver.fixture.ts";
import { createComputerAdapter } from "./driver.ts";
import { createFakeHelper } from "./fake-helper.fixture.ts";
import { createHelperRunner } from "./helper.ts";

describe("stop", () => {
  test("after a stop the running helper dies and no later command runs", async () => {
    const fake = createFakeHelper();
    fake.script({ "list-windows": windows(), "list-apps": APPS, snapshot: snap(), click: "hang" });
    const settled: Settled[] = [];
    let clickPid = 0;
    let clicked: () => void = () => {};
    const clicking = new Promise<void>((resolve) => {
      clicked = resolve;
    });
    const adapter = createComputerAdapter(
      {
        device_id: DEVICE,
        snapshot: () => ({ ...ON, helper: { path: fake.path, state_root: fake.state_root } }),
        idleSeconds: async () => 5,
        sleep: async () => {},
        now: () => NOW,
        progress: () => {},
        helperFor: (spec) =>
          createHelperRunner(spec, {
            onSpawn: (pid, args) => {
              if (args[0] !== "click") return;
              clickPid = pid;
              clicked();
            },
          }),
      },
      "1.0.0",
    );
    const queue = createRunnerQueue({
      execute: (cmd, signal) => adapter.execute(cmd, signal),
      settle: (item) => settled.push(item),
      now: () => NOW,
    });
    queue.submit(command("computer.snapshot", { window_id: "w-1" }, "read"));
    queue.submit(command("computer.press", { window_id: "w-1", ref: "@s1:e2" }, "press"));
    queue.submit(command("computer.press", { window_id: "w-1", ref: "@s1:e2" }, "later"));
    await clicking;
    const before = fake.calls().length;
    queue.stop(1);
    await queue.idle();
    await queue.idle();
    expect(settled.find((item) => item.command_id === "press")?.result).toEqual({
      status: "stopped",
    });
    expect(settled.find((item) => item.command_id === "later")?.result).toMatchObject({
      status: "stopped",
    });
    expect(fake.calls().length).toBe(before);
    let alive = true;
    try {
      process.kill(clickPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});
