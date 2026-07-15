// Reducer coverage for the terminal `citations` frame — it attaches source
// refs to the anchored assistant message (or the last one), and never
// fabricates a row when there is nothing to anchor to.

import { describe, expect, test } from "bun:test";
import { applyTurnEvent, type Citation, initialSessionState } from "./turn-event.ts";

const CITE: Citation[] = [
  { source_type: "knowledge_chunk", id: "chunk-1", source_name: "Weather Runbook", excerpt: "…" },
];

describe("applyTurnEvent · citations frame", () => {
  test("attaches to the assistant message named by parent_message_id", () => {
    let state = initialSessionState("c1");
    state = applyTurnEvent(state, { type: "message", role: "user", content: "hi", id: "u1" });
    state = applyTurnEvent(state, { type: "message", role: "assistant", content: "A1", id: "a1" });
    state = applyTurnEvent(state, { type: "message", role: "assistant", content: "A2", id: "a2" });
    state = applyTurnEvent(state, { type: "citations", citations: CITE, parent_message_id: "a1" });

    const a1 = state.messages.find((m) => m.id === "a1");
    const a2 = state.messages.find((m) => m.id === "a2");
    expect(a1?.citations).toEqual(CITE);
    expect(a2?.citations).toBeUndefined();
  });

  test("falls back to the last assistant message when parent_message_id is absent", () => {
    let state = initialSessionState("c2");
    state = applyTurnEvent(state, { type: "message", role: "assistant", content: "A1", id: "a1" });
    state = applyTurnEvent(state, { type: "message", role: "assistant", content: "A2", id: "a2" });
    state = applyTurnEvent(state, { type: "citations", citations: CITE });

    expect(state.messages.find((m) => m.id === "a2")?.citations).toEqual(CITE);
    expect(state.messages.find((m) => m.id === "a1")?.citations).toBeUndefined();
  });

  test("empty citations array is a no-op", () => {
    let state = initialSessionState("c3");
    state = applyTurnEvent(state, { type: "message", role: "assistant", content: "A", id: "a1" });
    const before = state;
    state = applyTurnEvent(state, { type: "citations", citations: [] });
    expect(state).toBe(before);
  });

  test("no assistant message to anchor to → no-op, no fabricated row", () => {
    let state = initialSessionState("c4");
    state = applyTurnEvent(state, { type: "message", role: "user", content: "hi", id: "u1" });
    const msgCount = state.messages.length;
    state = applyTurnEvent(state, { type: "citations", citations: CITE });
    expect(state.messages.length).toBe(msgCount);
    expect(state.messages.some((m) => m.citations)).toBe(false);
  });
});
