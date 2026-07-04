import { describe, expect, it } from "bun:test";
import { EventSink } from "../event-sink.ts";
import type { TurnEvent } from "../types.ts";

describe("EventSink", () => {
  it("invokes the emitter synchronously on every push", () => {
    const received: TurnEvent[] = [];
    const sink = new EventSink((ev) => received.push(ev));
    sink.push({ type: "text_delta", text: "hi" });
    sink.push({ type: "text_delta", text: " there" });
    expect(received).toHaveLength(2);
    expect(received[0]?.type).toBe("text_delta");
    expect(sink.events).toHaveLength(2);
  });

  it("buffers when no emitter supplied", () => {
    const sink = new EventSink();
    sink.push({ type: "message", role: "user", content: { text: "x" } });
    expect(sink.events).toHaveLength(1);
  });

  it("swallows emitter errors — buffered replay stays valid", () => {
    const sink = new EventSink(() => {
      throw new Error("boom");
    });
    expect(() => sink.push({ type: "committed", workflow_id: "w1" })).not.toThrow();
    expect(sink.events).toHaveLength(1);
  });

  it("asArrayProxy() forwards .push calls into the emitter", () => {
    const received: TurnEvent[] = [];
    const sink = new EventSink((ev) => received.push(ev));
    const arr = sink.asArrayProxy();
    arr.push({ type: "text_delta", text: "live" });
    expect(received).toHaveLength(1);
    expect(arr.length).toBe(1);
  });
});
