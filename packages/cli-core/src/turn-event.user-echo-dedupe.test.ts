import { describe, expect, test } from "bun:test";
import { applyTurnEvent, initialSessionState, type TurnEvent } from "./turn-event.ts";

describe("applyTurnEvent · user-message echo dedupe", () => {
  test("replaces optimistic user message in-place when engine echo arrives", () => {
    let state = initialSessionState("conv-1");
    state = {
      ...state,
      messages: [...state.messages, { role: "user", content: "3" }],
    };
    expect(state.messages).toHaveLength(1);
    const ev: TurnEvent = {
      type: "message",
      role: "user",
      content: "3",
      id: "msg-eng-001",
    };
    const next = applyTurnEvent(state, ev);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]?.id).toBe("msg-eng-001");
    expect(next.messages[0]?.role).toBe("user");
    expect(next.messages[0]?.content).toBe("3");
  });

  test("supersedes optimistic echo even when client preprocessor rewrote content", () => {
    let state = initialSessionState("conv-2");
    state = {
      ...state,
      messages: [
        ...state.messages,
        {
          role: "user",
          content: "create a knowledge source from /Users/me/doc.md",
        },
      ],
    };
    const ev: TurnEvent = {
      type: "message",
      role: "user",
      content:
        'create a knowledge source from {"$file":"fid_00000000-0000-0000-0000-000000000001"}',
      id: "msg-eng-002",
    };
    const next = applyTurnEvent(state, ev);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]?.id).toBe("msg-eng-002");
    expect(next.messages[0]?.content).toContain('"$file"');
  });

  test("collapses two engine-anchored user messages with identical content into one (bug GG)", () => {
    let state = initialSessionState("conv-3");
    state = {
      ...state,
      messages: [...state.messages, { role: "user", content: "approve", id: "msg-eng-prev" }],
    };
    const ev: TurnEvent = {
      type: "message",
      role: "user",
      content: "approve",
      id: "msg-eng-002",
    };
    const next = applyTurnEvent(state, ev);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]?.id).toBe("msg-eng-002");
  });

  test("keeps two engine-anchored user messages when content differs", () => {
    let state = initialSessionState("conv-3b");
    state = {
      ...state,
      messages: [...state.messages, { role: "user", content: "approve", id: "msg-eng-prev" }],
    };
    const ev: TurnEvent = {
      type: "message",
      role: "user",
      content: "decline",
      id: "msg-eng-003",
    };
    const next = applyTurnEvent(state, ev);
    expect(next.messages).toHaveLength(2);
    expect(next.messages.map((m) => m.id)).toEqual(["msg-eng-prev", "msg-eng-003"]);
  });

  test("appends assistant messages normally (dedupe is user-only)", () => {
    let state = initialSessionState("conv-4");
    state = {
      ...state,
      messages: [...state.messages, { role: "user", content: "hi" }],
    };
    const ev: TurnEvent = {
      type: "message",
      role: "assistant",
      content: "hi",
      id: "msg-eng-asst",
    };
    const next = applyTurnEvent(state, ev);
    expect(next.messages).toHaveLength(2);
  });

  test("trims content for comparison so trailing whitespace doesn't break dedupe", () => {
    let state = initialSessionState("conv-5");
    state = {
      ...state,
      messages: [...state.messages, { role: "user", content: "yes" }],
    };
    const ev: TurnEvent = {
      type: "message",
      role: "user",
      content: "yes ",
      id: "msg-eng-005",
    };
    const next = applyTurnEvent(state, ev);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]?.id).toBe("msg-eng-005");
  });

  test("preserves engine-anchored user messages when the engine emits a NEW user message with different content", () => {
    let state = initialSessionState("conv-6");
    state = {
      ...state,
      messages: [...state.messages, { role: "user", content: "first", id: "A" }],
    };
    const ev: TurnEvent = {
      type: "message",
      role: "user",
      content: "second",
      id: "B",
    };
    const next = applyTurnEvent(state, ev);
    expect(next.messages).toHaveLength(2);
    expect(next.messages[0]?.id).toBe("A");
    expect(next.messages[0]?.content).toBe("first");
    expect(next.messages[1]?.id).toBe("B");
    expect(next.messages[1]?.content).toBe("second");
  });
});
