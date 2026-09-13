// Reducer behaviour for the new `diff` TurnEvent on the cli-core
// session-state path. Threads the diff under the most recent
// assistant message; never appends to messages or cells.

import { describe, expect, test } from "bun:test";

import { applyTurnEvent, initialSessionState } from "../turn-event.ts";

describe("applyTurnEvent · diff", () => {
  test("appends the diff to session.diffs", () => {
    let state = initialSessionState(null);
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: "ok" },
      id: "m1",
    });
    state = applyTurnEvent(state, {
      type: "diff",
      title: "workflow · my-wf",
      language: "json",
      hunks: [
        { kind: "-", text: "old" },
        { kind: "+", text: "new" },
      ],
    });
    expect(state.diffs.length).toBe(1);
    expect(state.diffs[0]?.title).toBe("workflow · my-wf");
    expect(state.diffs[0]?.parentMessageId).toBe("m1");
    expect(state.diffs[0]?.hunks).toEqual([
      { kind: "-", text: "old" },
      { kind: "+", text: "new" },
    ]);
  });

  test("does NOT add a message when a diff arrives", () => {
    const state = initialSessionState(null);
    const next = applyTurnEvent(state, {
      type: "diff",
      title: "x",
      language: "text",
      hunks: [{ kind: "+", text: "y" }],
    });
    expect(next.messages.length).toBe(0);
  });

  test("multiple diffs land in order", () => {
    let state = initialSessionState(null);
    state = applyTurnEvent(state, {
      type: "diff",
      title: "first",
      language: "json",
      hunks: [{ kind: "+", text: "a" }],
    });
    state = applyTurnEvent(state, {
      type: "diff",
      title: "second",
      language: "json",
      hunks: [{ kind: "+", text: "b" }],
    });
    expect(state.diffs.map((d) => d.title)).toEqual(["first", "second"]);
  });
});
