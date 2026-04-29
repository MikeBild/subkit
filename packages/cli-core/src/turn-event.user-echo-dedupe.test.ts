// Bug 1 — when the ink CLI optimistically inserts a `user` message
// before awaiting the engine round-trip (so the operator sees their
// "3" / "yes" immediately), the engine's persisted `message` event
// must replace the optimistic copy in-place rather than appending a
// duplicate `you` line. Pre-fix the user saw their input twice once
// the engine echoed back; pre-fix-pre-fix they didn't see it at all
// during the engine wait window (session 09219b6d).

import { describe, expect, test } from "bun:test";
import { applyTurnEvent, initialSessionState, type TurnEvent } from "./turn-event.ts";

describe("applyTurnEvent · user-message echo dedupe", () => {
  test("replaces optimistic user message in-place when engine echo arrives", () => {
    let state = initialSessionState("conv-1");
    // Step 1: ink-app pushes the optimistic local user message.
    state = {
      ...state,
      messages: [...state.messages, { role: "user", content: "3" }],
    };
    expect(state.messages).toHaveLength(1);
    // Step 2: engine round-trip completes and emits a persisted
    // `message` event with id, same content (after trim).
    const ev: TurnEvent = {
      type: "message",
      role: "user",
      content: "3",
      id: "msg-eng-001",
    };
    const next = applyTurnEvent(state, ev);
    // Same length — the optimistic copy was REPLACED, not appended.
    expect(next.messages).toHaveLength(1);
    // The replacement carries the engine-assigned id.
    expect(next.messages[0]?.id).toBe("msg-eng-001");
    expect(next.messages[0]?.role).toBe("user");
    expect(next.messages[0]?.content).toBe("3");
  });

  test("appends as new message when content differs (no dedupe)", () => {
    let state = initialSessionState("conv-2");
    state = {
      ...state,
      messages: [...state.messages, { role: "user", content: "yes" }],
    };
    const ev: TurnEvent = {
      type: "message",
      role: "user",
      content: "no, actually run option 2",
      id: "msg-eng-002",
    };
    const next = applyTurnEvent(state, ev);
    expect(next.messages).toHaveLength(2);
  });

  test("collapses two engine-anchored user messages with identical content into one (bug GG)", () => {
    // Pre-fix session dcdcf246: the engine replayed the same user
    // turn twice and the CLI rendered "› you 1 / › you 1" stacked.
    // Same-content user-message replays from the engine collapse to
    // the most recent one — different ids on the same trimmed text
    // are treated as the same logical input, since the operator only
    // typed it once.
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
    // The newer engine-assigned id wins.
    expect(next.messages[0]?.id).toBe("msg-eng-002");
  });

  test("keeps two engine-anchored user messages when content differs", () => {
    // The dedupe only fires on identical trimmed content. Two
    // distinct user messages with different content stay distinct
    // even when both came from the engine.
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
    // user + assistant — both kept.
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
});
