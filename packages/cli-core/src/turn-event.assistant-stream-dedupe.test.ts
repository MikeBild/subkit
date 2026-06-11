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
