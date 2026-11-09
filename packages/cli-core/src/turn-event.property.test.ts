import { expect, test } from "bun:test";
import fc from "fast-check";
import { applyTurnEvent, initialSessionState } from "./turn-event.ts";

test("text delta reduction is immutable and preserves delta order", () => {
  fc.assert(
    fc.property(fc.array(fc.string(), { maxLength: 40 }), (deltas) => {
      const initial = initialSessionState("conversation-1");
      const next = deltas.reduce(
        (state, text) => applyTurnEvent(state, { type: "text_delta", text }),
        initial,
      );
      expect(initial.streamingAssistantText).toBe("");
      expect(next.streamingAssistantText).toBe(deltas.join(""));
      expect(next === initial).toBe(deltas.length === 0);
    }),
    { seed: 20_261_109, numRuns: 200 },
  );
});
