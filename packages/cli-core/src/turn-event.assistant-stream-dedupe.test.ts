// Duplicate-assistant-output bug — debug.log forensics, conversation
// 68b5c87e (seq 477–491): during an elicitation-resolution turn the
// engine emitted the persisted assistant `message` event MID-STREAM
// (self-parented: parent_message_id === id), then kept delivering
// `text_delta` frames that replayed the TAIL of that same text. The
// reducer cleared `streamingAssistantText` on the message, then
// re-accumulated the tail — and `completed` never clears the buffer —
// so the Ink transcript rendered the full message followed by a
// dangling partial duplicate starting mid-sentence.
//
// Contract under test: a `message` event whose text equals (or
// prefix-extends) the delta-accumulated assistant text reconciles into
// ONE transcript cell, and late deltas that replay already-materialized
// text are swallowed. Legitimate multi-message turns (distinct texts)
// and genuinely new post-message streams still render.

import { describe, expect, test } from "bun:test";

import { applyTurnEvent, initialSessionState, type TurnEvent } from "./turn-event.ts";

const FULL_TEXT =
  "The engine is enforcing a cooldown: the probe failed ~40s ago. " +
  "Your options:\n1. Re-probe in ~20 seconds — wait for the cooldown and try " +
  "saving again (the API may recover).\n2. Rotate the credential.";

// Split exactly like the forensic stream: deltas up to a mid-sentence
// point, the persisted message, then the remaining tail as deltas.
const STREAMED_PREFIX = FULL_TEXT.slice(0, FULL_TEXT.indexOf("saving again"));
const TAIL_AFTER_MESSAGE = FULL_TEXT.slice(FULL_TEXT.indexOf("saving again"));

const SELF_PARENTED_ID = "4e2d3da7-b794-4b7d-95ee-5d04e69f8c1d";

function assistantMessages(state: ReturnType<typeof initialSessionState>) {
  return state.messages.filter((m) => m.role === "assistant");
}

describe("applyTurnEvent · assistant stream/message dedupe", () => {
  test("forensic replay 68b5c87e — persisted message mid-stream + trailing tail deltas yield ONE assistant cell and an empty stream buffer", () => {
    let state = initialSessionState("conv-68b5c87e");
    // Deltas up to the mid-sentence point where the message landed.
    state = applyTurnEvent(state, { type: "text_delta", text: STREAMED_PREFIX.slice(0, 30) });
    state = applyTurnEvent(state, { type: "text_delta", text: STREAMED_PREFIX.slice(30) });
    // The persisted assistant message — full text, SELF-parented.
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: FULL_TEXT },
      id: SELF_PARENTED_ID,
      parent_message_id: SELF_PARENTED_ID,
    });
    // Late deltas replaying the tail of the already-materialized text —
    // pre-fix these re-populated streamingAssistantText with a
    // mid-sentence fragment that rendered below the full message.
    state = applyTurnEvent(state, { type: "text_delta", text: TAIL_AFTER_MESSAGE.slice(0, 40) });
    state = applyTurnEvent(state, { type: "text_delta", text: TAIL_AFTER_MESSAGE.slice(40) });
    state = applyTurnEvent(state, { type: "completed", status: "active" });

    expect(assistantMessages(state)).toHaveLength(1);
    expect(assistantMessages(state)[0]?.content).toBe(FULL_TEXT);
    // The dangling partial duplicate — the actual user-visible bug.
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
    // Genuinely NEW assistant text — must stream, not be swallowed.
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
    // "xyz" replays the materialized tail; "123" is new text.
    state = applyTurnEvent(state, { type: "text_delta", text: "xyz123" });
    expect(state.streamingAssistantText).toBe("123");
    expect(assistantMessages(state)).toHaveLength(1);
  });

  // ── Forensics, conversation 35a3b9ba (sk 6.17.0, ~19:11:57) ────────
  //
  // The engine's delta stream is a CONTINUOUS lagging replay of the
  // concatenated assistant texts: the persisted `message` event can land
  // BEFORE any of its `text_delta` frames (seq 153 message, seq 154
  // delta with the identical full text), and a single delta can span a
  // message boundary (seq 135: tail of message ba3d4a8f + the full text
  // of message 87abe312 in ONE frame). Pre-fix, `applyAssistantMessage`
  // only armed `expectedStreamTail` when the stream buffer was a
  // NON-EMPTY prefix of the persisted text — so a message arriving ahead
  // of its deltas armed nothing, the full-text replay delta accumulated
  // into `streamingAssistantText`, and the Ink view rendered the same
  // assistant text above the pending ask_user_form panel (persisted
  // message, static) AND below it (live-delta row, dynamic).

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
    // Persisted message lands BEFORE its delta replay (self-parented).
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: XRAY_TEXT },
      id: XRAY_MSG_ID,
      parent_message_id: XRAY_MSG_ID,
    });
    // The full-text replay delta — the second visual copy pre-fix.
    state = applyTurnEvent(state, { type: "text_delta", text: XRAY_TEXT });
    state = applyTurnEvent(state, { type: "completed", status: "awaiting_input" });
    return state;
  }

  test("forensic replay 35a3b9ba — message AHEAD of its delta replay with a pending form yields ONE assistant cell and an empty stream buffer", () => {
    const state = replayXrayElicitTurn();
    expect(assistantMessages(state)).toHaveLength(1);
    expect(assistantMessages(state)[0]?.content).toBe(XRAY_TEXT);
    // The user-visible bug: the replayed delta re-populated the live
    // buffer, rendering the same text again below the form panel.
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
    // Lagging replay of T1's head…
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
    // …then ONE delta carrying the rest of T1 AND all of T2 (seq 135).
    state = applyTurnEvent(state, { type: "text_delta", text: T1.slice(40) + T2 });
    state = applyTurnEvent(state, { type: "completed", status: "awaiting_input" });

    expect(assistantMessages(state).map((m) => m.content)).toEqual([T1, T2]);
    expect(state.streamingAssistantText).toBe("");
  });

  test("resolving the elicitation in the next turn keeps the message and renders the follow-up", () => {
    let state = replayXrayElicitTurn();
    // Next turn (elicitation resolved): a fresh stream with new text.
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
    // Turn 1: message persisted, but the engine never replays its
    // deltas before the stream closes.
    state = applyTurnEvent(state, {
      type: "message",
      role: "assistant",
      content: { text: "First turn text that never got a delta replay." },
      id: "msg-t1",
    });
    state = applyTurnEvent(state, { type: "completed", status: "active" });
    // Turn 2: a new SSE stream — replay expectations from the closed
    // stream are void. The new turn's own ahead-of-delta replay must
    // still be swallowed.
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
