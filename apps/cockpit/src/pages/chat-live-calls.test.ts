import { describe, expect, test } from "bun:test";
import { applyLiveCall, elapsedMs, type LiveCall, reduceLiveCall } from "./chat-live-calls";

const NOW = Date.parse("2026-08-18T12:00:00.000Z");

describe("reduceLiveCall", () => {
  test("reads the three frames the engine already sends", () => {
    expect(
      reduceLiveCall({ type: "tool_call_start", call_id: "c1", tool: "run_workflow" }, NOW),
    ).toEqual({ kind: "start", callId: "c1", toolName: "run_workflow", at: NOW });
    expect(
      reduceLiveCall({ type: "tool_log", call_id: "c1", message: "step 2 of 5" }, NOW),
    ).toEqual({
      kind: "log",
      callId: "c1",
      message: "step 2 of 5",
    });
    expect(reduceLiveCall({ type: "tool_call_end", call_id: "c1" }, NOW)).toEqual({
      kind: "end",
      callId: "c1",
    });
  });

  test("ignores the frames this reducer is not about", () => {
    expect(reduceLiveCall({ type: "text_delta", text: "hi" }, NOW)).toBeNull();
    expect(reduceLiveCall({ type: "tool_call_start" }, NOW)).toBeNull();
    expect(reduceLiveCall({ type: "tool_log", call_id: "c1" }, NOW)).toBeNull();
  });
});

describe("applyLiveCall", () => {
  const started = applyLiveCall([], {
    kind: "start",
    callId: "c1",
    toolName: "run_workflow",
    at: NOW,
  });

  test("records a starting call once, even if the frame repeats", () => {
    const twice = applyLiveCall(started, {
      kind: "start",
      callId: "c1",
      toolName: "run_workflow",
      at: NOW + 5,
    });
    expect(twice).toHaveLength(1);
    expect(twice[0]?.startedAt).toBe(NOW);
  });

  test("keeps only the latest log line", () => {
    const first = applyLiveCall(started, { kind: "log", callId: "c1", message: "one" });
    const second = applyLiveCall(first, { kind: "log", callId: "c1", message: "two" });
    expect(second[0]?.logTail).toBe("two");
  });

  test("an end frame stops the call without dropping it", () => {
    const ended = applyLiveCall(started, { kind: "end", callId: "c1" });
    expect(ended[0]?.done).toBe(true);
  });

  test("a frame for an unknown call does not throw or invent an entry", () => {
    expect(applyLiveCall([], { kind: "end", callId: "ghost" })).toEqual([]);
    expect(applyLiveCall([], { kind: "log", callId: "ghost", message: "x" })).toEqual([]);
  });

  test("arrival order is preserved across calls", () => {
    const two = applyLiveCall(started, { kind: "start", callId: "c2", toolName: "x", at: NOW + 1 });
    expect(two.map((call) => call.callId)).toEqual(["c1", "c2"]);
  });
});

describe("elapsedMs", () => {
  const call: LiveCall = {
    callId: "c1",
    toolName: "run_workflow",
    startedAt: NOW,
    logTail: null,
    done: false,
  };

  test("measures from the start frame while the call runs", () => {
    expect(elapsedMs(call, NOW + 4_000)).toBe(4_000);
  });

  test("a finished call reports nothing rather than a frozen number", () => {
    // No duration is persisted anywhere, so a reloaded transcript must show
    // no timer at all — not a zero, and not a value it made up.
    expect(elapsedMs({ ...call, done: true }, NOW + 4_000)).toBeNull();
  });

  test("a clock that went backwards never produces a negative age", () => {
    expect(elapsedMs(call, NOW - 1_000)).toBe(0);
  });
});
