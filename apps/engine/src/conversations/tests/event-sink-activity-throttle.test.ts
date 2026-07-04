// EventSink activity throttling — same `(phase, label)` pairs emitted
// within 200ms collapse to a single wire emission, while non-activity
// events pass through untouched.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventSink } from "../event-sink.ts";
import type { TurnEvent } from "../types.ts";

describe("EventSink activity throttling", () => {
  let now = 0;
  let originalDateNow: typeof Date.now;

  beforeEach(() => {
    now = 1_000_000;
    originalDateNow = Date.now;
    Date.now = () => now;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  test("collapses identical (phase, label) emits within the throttle window", () => {
    const emitter = mock((_ev: TurnEvent) => {});
    const sink = new EventSink(emitter);

    const burst: TurnEvent = {
      type: "activity",
      phase: "tool",
      label: "inspect_workflow",
    };

    sink.push(burst);
    sink.push(burst);
    sink.push(burst);

    expect(emitter).toHaveBeenCalledTimes(1);
    expect(sink.events.length).toBe(3); // buffer keeps every event for replay
  });

  test("emits again after the throttle window elapses", () => {
    const emitter = mock((_ev: TurnEvent) => {});
    const sink = new EventSink(emitter);

    const burst: TurnEvent = {
      type: "activity",
      phase: "tool",
      label: "inspect_workflow",
    };

    sink.push(burst);
    now += 250; // > 200ms throttle window
    sink.push(burst);

    expect(emitter).toHaveBeenCalledTimes(2);
  });

  test("does NOT collapse different phases or labels", () => {
    const emitter = mock((_ev: TurnEvent) => {});
    const sink = new EventSink(emitter);

    sink.push({ type: "activity", phase: "tool", label: "a" });
    sink.push({ type: "activity", phase: "tool", label: "b" });
    sink.push({ type: "activity", phase: "composing", label: "a" });

    expect(emitter).toHaveBeenCalledTimes(3);
  });

  test("non-activity events bypass the throttle", () => {
    const emitter = mock((_ev: TurnEvent) => {});
    const sink = new EventSink(emitter);

    sink.push({ type: "text_delta", text: "x" });
    sink.push({ type: "text_delta", text: "x" });
    sink.push({ type: "text_delta", text: "x" });

    expect(emitter).toHaveBeenCalledTimes(3);
  });
});
