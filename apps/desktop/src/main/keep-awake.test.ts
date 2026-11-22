import { describe, expect, test } from "bun:test";
import { KeepAwake, type PowerBlocker } from "./keep-awake.ts";

function fakePower(): PowerBlocker & { active: Set<number>; calls: string[] } {
  let next = 1;
  const active = new Set<number>();
  const calls: string[] = [];
  return {
    active,
    calls,
    start(type) {
      calls.push(`start:${type}`);
      const id = next++;
      active.add(id);
      return id;
    },
    stop(id) {
      calls.push(`stop:${id}`);
      active.delete(id);
    },
  };
}

const running = { type: "step_started", command_id: "c1" } as const;

describe("KeepAwake", () => {
  test("holds one app-suspension blocker while a local step runs and releases it after", () => {
    const power = fakePower();
    const awake = new KeepAwake(power);
    awake.apply(running);
    expect(awake.holding()).toBe(true);
    expect(power.calls).toEqual(["start:prevent-app-suspension"]);
    awake.apply({ type: "step_ended", command_id: "c1" });
    expect(awake.holding()).toBe(false);
    expect(power.active.size).toBe(0);
  });

  test("a runner crash mid-step releases the blocker", () => {
    const power = fakePower();
    const awake = new KeepAwake(power);
    awake.apply(running);
    awake.apply({ type: "runner_ended" });
    expect(awake.holding()).toBe(false);
    expect(power.active.size).toBe(0);
    expect(power.calls).toEqual(["start:prevent-app-suspension", "stop:1"]);
  });
});
