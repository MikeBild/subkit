import { describe, expect, test } from "bun:test";
import type { RunLoopResult } from "../../conversations/loop.ts";
import type { TurnEvent } from "../../conversations/types.ts";
import { extractAssistantText } from "../dispatcher.ts";

function result(events: TurnEvent[]): RunLoopResult {
  return { events, status: "active" } as RunLoopResult;
}

describe("extractAssistantText", () => {
  test("returns the last assistant `message` content.text", () => {
    const r = result([
      { type: "message", role: "user", content: { text: "hi" } },
      { type: "message", role: "assistant", content: { text: "hello back" } },
    ] as TurnEvent[]);
    expect(extractAssistantText(r)).toBe("hello back");
  });

  test("handles assistant content as a bare string", () => {
    const r = result([
      { type: "message", role: "assistant", content: "bare reply" },
    ] as TurnEvent[]);
    expect(extractAssistantText(r)).toBe("bare reply");
  });

  test("prefers the assistant message over text_delta deltas", () => {
    const r = result([
      { type: "text_delta", text: "del " },
      { type: "text_delta", text: "ta" },
      { type: "message", role: "assistant", content: { text: "real reply" } },
    ] as TurnEvent[]);
    expect(extractAssistantText(r)).toBe("real reply");
  });

  test("falls back to concatenated text_delta when no assistant message", () => {
    const r = result([
      { type: "text_delta", text: "hello " },
      { type: "text_delta", text: "world" },
    ] as TurnEvent[]);
    expect(extractAssistantText(r)).toBe("hello world");
  });

  test("returns null when there's neither", () => {
    const r = result([{ type: "message", role: "user", content: { text: "hi" } }] as TurnEvent[]);
    expect(extractAssistantText(r)).toBeNull();
  });

  test("trims whitespace and treats whitespace-only as null", () => {
    expect(
      extractAssistantText(
        result([
          { type: "message", role: "assistant", content: { text: "  ok  " } },
        ] as TurnEvent[]),
      ),
    ).toBe("ok");
    expect(
      extractAssistantText(
        result([{ type: "message", role: "assistant", content: { text: "   " } }] as TurnEvent[]),
      ),
    ).toBeNull();
  });
});
