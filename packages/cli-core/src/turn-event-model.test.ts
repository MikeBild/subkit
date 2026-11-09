import { expect, test } from "bun:test";
import fc from "fast-check";
import { applyTurnEvent, initialSessionState } from "./turn-event-model.ts";

test("activity and diff use the supplied instant and preserve their source state", () => {
  fc.assert(
    fc.property(fc.integer(), fc.string(), (now, label) => {
      const initial = initialSessionState(null);
      const before = structuredClone(initial);
      const activity = applyTurnEvent(initial, { type: "activity", phase: "tool", label }, now);
      expect(activity.activity?.updated_at).toBe(now);
      expect(activity.activity?.label).toBe(label);
      const diff = applyTurnEvent(
        initial,
        { type: "diff", title: label, language: "text", hunks: [] },
        now,
      );
      expect(diff.diffs[0]?.id).toBe(`diff-0-${now}`);
      const next = applyTurnEvent(
        diff,
        { type: "diff", title: label, language: "text", hunks: [] },
        now,
      );
      expect(next.diffs[1]?.id).toBe(`diff-1-${now}`);
      expect(diff.diffs).toHaveLength(1);
      expect(initial).toEqual(before);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});
