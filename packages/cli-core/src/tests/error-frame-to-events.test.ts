import { describe, expect, test } from "bun:test";
import { applyTurnEvent, errorFrameToEvents, initialSessionState } from "../turn-event.ts";

describe("errorFrameToEvents", () => {
  test("a plain error becomes a single validation_error", () => {
    const events = errorFrameToEvents({ code: "internal", message: "boom" });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "validation_error",
      errors: [{ path: "internal", message: "boom" }],
    });
  });

  test("pending_elicitation_blocked replays the dialog as an elicit_request", () => {
    const events = errorFrameToEvents({
      code: "pending_elicitation_blocked",
      message: "resolve the pending dialog before sending another prompt",
      details: {
        conversation_status: "awaiting_input",
        pending_elicitation: {
          id: "elic-1",
          tool_name: "ask_user_confirm",
          summary: "Diagnose the transform?",
          tool_call_id: "tc-9",
          input: { question: "Diagnose the transform?", risk_level: "medium" },
        },
      },
    });
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("validation_error");
    expect(events[1]).toEqual({
      type: "elicit_request",
      elicitation_id: "elic-1",
      tool_name: "ask_user_confirm",
      summary: "Diagnose the transform?",
      input: { question: "Diagnose the transform?", risk_level: "medium" },
      tool_call_id: "tc-9",
    });
  });

  test("applying the events restores pendingElicitation and ends awaiting_input", () => {
    let state = initialSessionState("conv-1");
    for (const ev of errorFrameToEvents({
      code: "pending_elicitation_blocked",
      message: "resolve the pending dialog before sending another prompt",
      details: {
        pending_elicitation: {
          id: "elic-2",
          tool_name: "ask_user_confirm",
          summary: "Fix it?",
        },
      },
    })) {
      state = applyTurnEvent(state, ev);
    }
    expect(state.pendingElicitation?.id).toBe("elic-2");
    expect(state.status).toBe("awaiting_input");
    expect(state.validationErrors).toHaveLength(1);
  });

  test("pending_elicitation_blocked with no recoverable dialog falls back to validation_error only", () => {
    const events = errorFrameToEvents({
      code: "pending_elicitation_blocked",
      message: "resolve the pending dialog before sending another prompt",
      details: { pending_elicitation: { tool_name: "ask_user_confirm" } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("validation_error");
  });
});
