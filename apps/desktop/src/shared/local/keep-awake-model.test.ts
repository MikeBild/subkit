import { describe, expect, test } from "bun:test";
import {
  type AwakeEvent,
  type AwakeState,
  awakeChange,
  awakeNext,
  NOT_HOLDING,
} from "./keep-awake-model.ts";

const task = (session_id: string): AwakeEvent => ({ type: "task_started", session_id });
const started = (command_id: string): AwakeEvent => ({ type: "step_started", command_id });
const ended = (command_id: string): AwakeEvent => ({ type: "step_ended", command_id });

function replay(events: readonly AwakeEvent[]): { state: AwakeState; changes: string[] } {
  let state = NOT_HOLDING;
  const changes: string[] = [];
  for (const event of events) {
    const next = awakeNext(state, event);
    const change = awakeChange(state, next);
    if (change) changes.push(change);
    state = next;
  }
  return { state, changes };
}

describe("keeping the Mac awake while local work runs", () => {
  test("a local step holds the Mac awake until it ends", () => {
    expect(replay([started("c1"), ended("c1")]).changes).toEqual(["start", "stop"]);
  });

  test("a local task holds it from its start to its end, across its steps", () => {
    const { changes } = replay([
      task("run-1"),
      started("c1"),
      ended("c1"),
      started("c2"),
      ended("c2"),
      { type: "task_ended" },
    ]);
    expect(changes).toEqual(["start", "stop"]);
  });

  test("a task that ends while one of its steps still runs keeps the hold for that step", () => {
    const { changes, state } = replay([task("run-1"), started("c1"), { type: "task_ended" }]);
    expect(changes).toEqual(["start"]);
    expect([...state.holds]).toEqual(["step:c1"]);
  });

  test("overlapping steps release only after the last one ends", () => {
    const { changes, state } = replay([started("c1"), started("c2"), ended("c1")]);
    expect(changes).toEqual(["start"]);
    expect(awakeChange(state, awakeNext(state, ended("c2")))).toBe("stop");
  });

  test("a repeated start or the end of an unknown step changes nothing", () => {
    const { changes, state } = replay([started("c1"), started("c1"), ended("other")]);
    expect(changes).toEqual(["start"]);
    expect([...state.holds]).toEqual(["step:c1"]);
  });

  test("a crashed, stopped or quitting runner releases every hold", () => {
    const { changes, state } = replay([
      task("run-1"),
      started("c1"),
      started("c2"),
      { type: "runner_ended" },
    ]);
    expect(changes).toEqual(["start", "stop"]);
    expect(state).toBe(NOT_HOLDING);
  });

  test("ends without anything running never start or stop a hold", () => {
    expect(replay([{ type: "task_ended" }, { type: "runner_ended" }, ended("c1")]).changes).toEqual(
      [],
    );
  });
});
