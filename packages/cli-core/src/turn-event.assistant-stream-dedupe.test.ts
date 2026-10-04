import { describe, expect, test } from "bun:test";
import { applyTurnEvent, initialSessionState, type TurnEvent } from "./turn-event.ts";

const FULL_TEXT =
  "The engine is enforcing a cooldown: the probe failed ~40s ago. " +
  "Your options:\n1. Re-probe in ~20 seconds — wait for the cooldown and try " +
  "saving again (the API may recover).\n2. Rotate the credential.";

const STREAMED_PREFIX = FULL_TEXT.slice(0, FULL_TEXT.indexOf("saving again"));
const TAIL_AFTER_MESSAGE = FULL_TEXT.slice(FULL_TEXT.indexOf("saving again"));

const SELF_PARENTED_ID = "4e2d3da7-b794-4b7d-95ee-5d04e69f8c1d";

function assistantMessages(state: ReturnType<typeof initialSessionState>) {
  return state.messages.filter((m) => m.role === "assistant");
}

describe("applyTurnEvent · assistant stream/message dedupe", () => {
  test("forensic replay 68b5c87e — persisted message mid-stream + trailing tail deltas yield ONE assistant cell and an empty stream buffer", () => {
    let state = initialSessionState("conv-68b5c87e");
    state = applyTurnEvent(state, { type: "text_delta", text: STREAMED_PREFIX.slice(0, 30) });
    state = applyTurnEvent(state, { type: "text_delta", text: STREAMED_PREFIX.slice(30) });
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: FULL_TEXT },
      id: SELF_PARENTED_ID,
      parent_message_id: SELF_PARENTED_ID,
    });
    state = applyTurnEvent(state, { type: "text_delta", text: TAIL_AFTER_MESSAGE.slice(0, 40) });
    state = applyTurnEvent(state, { type: "text_delta", text: TAIL_AFTER_MESSAGE.slice(40) });
    state = applyTurnEvent(state, { type: "completed", status: "active" });

    expect(assistantMessages(state)).toHaveLength(1);
    expect(assistantMessages(state)[0]?.content).toBe(FULL_TEXT);
    expect(state.streamingAssistantText).toBe("");
  });

  test("deltas + completed + self-parented message with identical text → ONE assistant entry", () => {
    let state = initialSessionState("conv-1");
    state = applyTurnEvent(state, { type: "text_delta", text: FULL_TEXT.slice(0, 100) });
    state = applyTurnEvent(state, { type: "text_delta", text: FULL_TEXT.slice(100) });
    state = applyTurnEvent(state, { type: "completed", status: "active" });
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: FULL_TEXT },
      id: SELF_PARENTED_ID,
      parent_message_id: SELF_PARENTED_ID,
    });
    expect(assistantMessages(state)).toHaveLength(1);
    expect(assistantMessages(state)[0]?.content).toBe(FULL_TEXT);
    expect(state.streamingAssistantText).toBe("");
  });

  test("delta-accumulated text + message with EXTENDED text reconciles to the longer text", () => {
    let state = initialSessionState("conv-2");
    state = applyTurnEvent(state, { type: "text_delta", text: "Hello wor" });
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: "Hello world — all checks passed." },
      id: "msg-ext",
    });
    expect(assistantMessages(state)).toHaveLength(1);
    expect(assistantMessages(state)[0]?.content).toBe("Hello world — all checks passed.");
    expect(state.streamingAssistantText).toBe("");
  });

  test("two DISTINCT assistant messages in one turn still yield two entries", () => {
    let state = initialSessionState("conv-3");
    state = applyTurnEvent(state, { type: "text_delta", text: "Checking the connector now." });
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: "Checking the connector now." },
      id: "msg-a",
    });
    state = applyTurnEvent(state, {
      type: "tool_call_start",
      call_id: "call-1",
      tool: "probe_connector",
      parent_message_id: "msg-a",
    });
    state = applyTurnEvent(state, {
      type: "tool_result",
      call_id: "call-1",
      tool: "probe_connector",
      output: { ok: true, data: { status: "healthy" } },
    });
    state = applyTurnEvent(state, { type: "text_delta", text: "Probe succeeded — saved." });
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: "Probe succeeded — saved." },
      id: "msg-b",
    });
    state = applyTurnEvent(state, { type: "completed", status: "active" });
    expect(assistantMessages(state)).toHaveLength(2);
    expect(assistantMessages(state).map((m) => m.content)).toEqual([
      "Checking the connector now.",
      "Probe succeeded — saved.",
    ]);
  });

  test("assistant message replayed with the SAME id reconciles in place instead of appending", () => {
    let state = initialSessionState("conv-4");
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: FULL_TEXT },
      id: "msg-same",
    });
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: FULL_TEXT },
      id: "msg-same",
      parent_message_id: "msg-same",
    });
    expect(assistantMessages(state)).toHaveLength(1);
    expect(assistantMessages(state)[0]?.id).toBe("msg-same");
    expect(assistantMessages(state)[0]?.content).toBe(FULL_TEXT);
  });

  test("identical-content adjacent assistant messages with different ids collapse to one (newest id wins)", () => {
    let state = initialSessionState("conv-5");
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: "All done." },
      id: "msg-old",
    });
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: "All done." },
      id: "msg-new",
    });
    expect(assistantMessages(state)).toHaveLength(1);
    expect(assistantMessages(state)[0]?.id).toBe("msg-new");
  });

  test("post-message delta that DIVERGES from the materialized text starts a fresh stream", () => {
    let state = initialSessionState("conv-6");
    state = applyTurnEvent(state, { type: "text_delta", text: FULL_TEXT.slice(0, 50) });
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: FULL_TEXT },
      id: "msg-c",
    });
    state = applyTurnEvent(state, { type: "text_delta", text: "Next, I'll verify the schedule." });
    expect(state.streamingAssistantText).toBe("Next, I'll verify the schedule.");
  });

  test("post-message delta that covers the remaining tail AND continues beyond streams only the overflow", () => {
    let state = initialSessionState("conv-7");
    state = applyTurnEvent(state, { type: "text_delta", text: "abc" });
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: "abcxyz" },
      id: "msg-d",
    });
    state = applyTurnEvent(state, { type: "text_delta", text: "xyz123" });
    expect(state.streamingAssistantText).toBe("123");
    expect(assistantMessages(state)).toHaveLength(1);
  });

  const XRAY_TEXT =
    "The OAuth2 flow for Xray Cloud requires collecting the client credentials " +
    "and then authenticating via browser. Since you provided client_id + " +
    "client_secret in the form, let me save the connector with those credentials embedded:";
  const XRAY_MSG_ID = "5d469761-4bee-41a5-9299-8c0cf980bcd8";

  function replayXrayElicitTurn(state = initialSessionState("conv-35a3b9ba")) {
    state = applyTurnEvent(state, {
      type: "tool_call_start",
      call_id: "5500300e",
      tool: "ask_user_form",
      input_partial: { question: "Confirm the OAuth2 credentials." },
      parent_message_id: XRAY_MSG_ID,
    });
    state = applyTurnEvent(state, {
      type: "tool_call_end",
      call_id: "5500300e",
      input: { question: "Confirm the OAuth2 credentials." },
      parent_message_id: XRAY_MSG_ID,
    });
    state = applyTurnEvent(state, {
      type: "tool_result",
      call_id: "5500300e",
      tool: "ask_user_form",
      output: { status: "awaiting_input", elicitation_id: "10fc2aaa" },
      parent_message_id: XRAY_MSG_ID,
    });
    state = applyTurnEvent(state, {
      type: "elicit_request",
      elicitation_id: "10fc2aaa",
      tool_call_id: "5500300e",
      tool_name: "ask_user_form",
      summary: "Confirm the OAuth2 credentials.",
      input: { question: "Confirm the OAuth2 credentials.", fields: [] },
      parent_message_id: XRAY_MSG_ID,
    });
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: XRAY_TEXT },
      id: XRAY_MSG_ID,
      parent_message_id: XRAY_MSG_ID,
    });
    state = applyTurnEvent(state, { type: "text_delta", text: XRAY_TEXT });
    state = applyTurnEvent(state, { type: "completed", status: "awaiting_input" });
    return state;
  }

  test("forensic replay 35a3b9ba — message AHEAD of its delta replay with a pending form yields ONE assistant cell and an empty stream buffer", () => {
    const state = replayXrayElicitTurn();
    expect(assistantMessages(state)).toHaveLength(1);
    expect(assistantMessages(state)[0]?.content).toBe(XRAY_TEXT);
    expect(state.streamingAssistantText).toBe("");
    expect(state.pendingElicitation?.id).toBe("10fc2aaa");
    expect(state.status).toBe("awaiting_input");
  });

  test("forensic replay 35a3b9ba — a single delta spanning a message boundary (tail of prior + full next text) is swallowed", () => {
    const T1 = "Perfect. Now I'll probe the connector to verify the credentials and endpoint work:";
    const T2 =
      "The probe detected that OAuth2 requires a different flow. For OAuth2, I need to " +
      "save the connector first with the credentials, then authenticate via the browser. " +
      "Let me save it with the client_id and client_secret:";
    let state = initialSessionState("conv-35a3b9ba");
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: T1 },
      id: "ba3d4a8f",
      parent_message_id: "ba3d4a8f",
    });
    state = applyTurnEvent(state, { type: "text_delta", text: T1.slice(0, 40) });
    state = applyTurnEvent(state, {
      type: "elicit_request",
      elicitation_id: "elc-x",
      tool_name: "ask_user_form",
      summary: "Save the connector?",
      input: {},
      parent_message_id: "87abe312",
    });
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: T2 },
      id: "87abe312",
      parent_message_id: "87abe312",
    });
    state = applyTurnEvent(state, { type: "text_delta", text: T1.slice(40) + T2 });
    state = applyTurnEvent(state, { type: "completed", status: "awaiting_input" });

    expect(assistantMessages(state).map((m) => m.content)).toEqual([T1, T2]);
    expect(state.streamingAssistantText).toBe("");
  });

  test("resolving the elicitation in the next turn keeps the message and renders the follow-up", () => {
    let state = replayXrayElicitTurn();
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: "Connector saved. Starting the browser OAuth2 flow." },
      id: "msg-next",
      parent_message_id: "msg-next",
    });
    state = applyTurnEvent(state, {
      type: "text_delta",
      text: "Connector saved. Starting the browser OAuth2 flow.",
    });
    state = applyTurnEvent(state, { type: "completed", status: "active" });

    expect(assistantMessages(state).map((m) => m.content)).toEqual([
      XRAY_TEXT,
      "Connector saved. Starting the browser OAuth2 flow.",
    ]);
    expect(state.streamingAssistantText).toBe("");
    expect(state.pendingElicitation).toBeNull();
  });

  test("an undelivered replay expectation does not leak across `completed` into the next turn's stream", () => {
    let state = initialSessionState("conv-leak");
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: "First turn text that never got a delta replay." },
      id: "msg-t1",
    });
    state = applyTurnEvent(state, { type: "completed", status: "active" });
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: "Second turn text." },
      id: "msg-t2",
    });
    state = applyTurnEvent(state, { type: "text_delta", text: "Second turn text." });
    state = applyTurnEvent(state, { type: "completed", status: "active" });

    expect(assistantMessages(state).map((m) => m.content)).toEqual([
      "First turn text that never got a delta replay.",
      "Second turn text.",
    ]);
    expect(state.streamingAssistantText).toBe("");
  });

  test("user-echo dedupe still works alongside the assistant dedupe", () => {
    let state = initialSessionState("conv-8");
    state = { ...state, messages: [{ role: "user", content: "yes" }] };
    state = applyTurnEvent(state, {
      type: "message",
      role: "user",
      content: "yes",
      id: "msg-user",
    } satisfies TurnEvent);
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: "Approved — running the tool." },
      id: "msg-asst",
    });
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]?.role).toBe("user");
    expect(state.messages[1]?.role).toBe("assistant");
  });
});
