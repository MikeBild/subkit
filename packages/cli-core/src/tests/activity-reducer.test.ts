// Reducer behaviour for the new `activity` TurnEvent — sets
// `session.activity`, never appends to `messages` / `cells`, clears
// on `completed`.

import { describe, expect, test } from "bun:test";

import { applyTurnEvent, initialSessionState } from "../turn-event.ts";

describe("applyTurnEvent · activity", () => {
  test("sets session.activity from a `tool` phase event", () => {
    const state = initialSessionState(null);
    const next = applyTurnEvent(state, {
      type: "activity",
      phase: "tool",
      label: "probe_connector_draft",
      tool_name: "probe_connector_draft",
      call_id: "tc-1",
    });
    expect(next.activity).not.toBeNull();
    expect(next.activity?.phase).toBe("tool");
    expect(next.activity?.label).toBe("probe_connector_draft");
    expect(next.activity?.tool_name).toBe("probe_connector_draft");
    expect(next.activity?.call_id).toBe("tc-1");
  });

  test("does NOT append a message when an activity event arrives", () => {
    const state = initialSessionState(null);
    const next = applyTurnEvent(state, {
      type: "activity",
      phase: "composing",
      label: "composing reply · claude-sonnet-4-6",
    });
    expect(next.messages.length).toBe(0);
  });

  test("preserves last_completed metadata for idle phase", () => {
    const state = initialSessionState(null);
    const next = applyTurnEvent(state, {
      type: "activity",
      phase: "idle",
      label: "last: delete_workflow ok · 142ms",
      last_completed: { tool_name: "delete_workflow", ok: true, duration_ms: 142 },
    });
    expect(next.activity?.last_completed?.tool_name).toBe("delete_workflow");
    expect(next.activity?.last_completed?.ok).toBe(true);
    expect(next.activity?.last_completed?.duration_ms).toBe(142);
  });

  test("each activity event replaces (does not stack) the prior payload", () => {
    let state = initialSessionState(null);
    state = applyTurnEvent(state, { type: "activity", phase: "tool", label: "a" });
    state = applyTurnEvent(state, { type: "activity", phase: "tool", label: "b" });
    state = applyTurnEvent(state, { type: "activity", phase: "composing", label: "c" });
    expect(state.activity?.phase).toBe("composing");
    expect(state.activity?.label).toBe("c");
  });

  test("clears activity when the turn completes", () => {
    let state = initialSessionState(null);
    state = applyTurnEvent(state, { type: "activity", phase: "tool", label: "x" });
    expect(state.activity).not.toBeNull();
    state = applyTurnEvent(state, { type: "completed", status: "completed" });
    expect(state.activity).toBeNull();
  });
});

describe("applyTurnEvent · session token accumulator", () => {
  test("starts at zero and adds turn_tokens on each completed", () => {
    let state = initialSessionState(null);
    expect(state.sessionTotalTokens).toBe(0);
    state = applyTurnEvent(state, {
      type: "completed",
      status: "completed",
      usage: { turn_tokens: 12_500, remaining_monthly_budget_tokens: null },
    });
    expect(state.sessionTotalTokens).toBe(12_500);
    state = applyTurnEvent(state, {
      type: "completed",
      status: "completed",
      usage: { turn_tokens: 7_300, remaining_monthly_budget_tokens: null },
    });
    expect(state.sessionTotalTokens).toBe(19_800);
  });

  test("ignores completed events without usage", () => {
    let state = initialSessionState(null);
    state = applyTurnEvent(state, { type: "completed", status: "completed" });
    expect(state.sessionTotalTokens).toBe(0);
  });
});
