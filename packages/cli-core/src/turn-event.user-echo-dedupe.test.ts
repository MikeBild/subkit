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

  test("supersedes optimistic echo even when client preprocessor rewrote content", () => {
    // Pre-6.2.12 the dedupe required content equality, so the
    // optimistic "create a knowledge source from /Users/.../foo.md"
    // and the engine's persisted "create a knowledge source from
    // {"$file":"fid_..."}" stayed as two distinct rows. Contract
    // changed in 6.2.12 because `apps/sk/src/lib/path-preprocessor.ts`
    // now rewrites the prompt before submit, so the two forms ARE
    // the same turn — just before vs. after preprocessing. The
    // busy-flag at the submit site guarantees one optimistic echo
    // per turn, so the next engine user-message event is its
    // persisted partner regardless of textual diff.
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

  test("preserves engine-anchored user messages when the engine emits a NEW user message with different content", () => {
    // The 6.2.12 contract: dedupe only collapses (a) a local no-id
    // echo against ANY engine user message, or (b) an engine-anchored
    // message against a new engine message with IDENTICAL trimmed
    // content. When content differs AND the prior is engine-anchored,
    // both messages are kept — they are genuinely distinct operator turns.
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
    // Both rows kept — different content, both engine-anchored.
    expect(next.messages).toHaveLength(2);
    expect(next.messages[0]?.id).toBe("A");
    expect(next.messages[0]?.content).toBe("first");
    expect(next.messages[1]?.id).toBe("B");
    expect(next.messages[1]?.content).toBe("second");
  });
});
