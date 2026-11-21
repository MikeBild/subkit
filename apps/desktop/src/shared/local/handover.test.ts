import { describe, expect, test } from "bun:test";
import { type HandoverState, handoverResult, stepHandover } from "./handover.ts";

const NONE: HandoverState<string> = { waiting: [] };

function begin(state: HandoverState<string>, command_id: string) {
  return stepHandover(state, { type: "begin", command_id, waiter: `w-${command_id}` });
}

describe("handing a step to the person and back", () => {
  test("a step waits until its person hands back, then only that step goes on", () => {
    const one = begin(NONE, "a");
    expect(one).toEqual({ state: { waiting: [{ command_id: "a", waiter: "w-a" }] }, settled: [] });
    const two = begin(one.state, "b");
    expect(two.state.waiting.map((wait) => wait.command_id)).toEqual(["a", "b"]);
    const again = begin(two.state, "a");
    expect(again.state).toBe(two.state);
    expect(again.settled).toEqual([]);
    expect(stepHandover(two.state, { type: "hand_back", command_id: "a" })).toEqual({
      state: { waiting: [{ command_id: "b", waiter: "w-b" }] },
      settled: [{ waiter: "w-a", outcome: "handed_back" }],
    });
  });

  test("a hand-back for a step that does not wait changes nothing", () => {
    const waiting = begin(NONE, "a").state;
    expect(stepHandover(waiting, { type: "hand_back", command_id: "x" })).toEqual({
      state: waiting,
      settled: [],
    });
    expect(stepHandover(NONE, { type: "abort", command_id: "a" }).settled).toEqual([]);
  });

  test("stop or an aborted step ends the wait without going on", () => {
    const waiting = begin(begin(NONE, "a").state, "b").state;
    expect(stepHandover(waiting, { type: "abort", command_id: "b" })).toEqual({
      state: { waiting: [{ command_id: "a", waiter: "w-a" }] },
      settled: [{ waiter: "w-b", outcome: "stopped" }],
    });
    expect(stepHandover(waiting, { type: "stop" })).toEqual({
      state: NONE,
      settled: [
        { waiter: "w-a", outcome: "stopped" },
        { waiter: "w-b", outcome: "stopped" },
      ],
    });
  });

  test("the device answers a hand-back as done and a stop as stopped", () => {
    expect(handoverResult("handed_back")).toEqual({
      status: "done",
      output: { handed_back: true },
      evidence: {},
    });
    expect(handoverResult("stopped")).toEqual({ status: "stopped" });
  });
});
