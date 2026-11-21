import { describe, expect, test } from "bun:test";
import { canReadAttention, inboxCount, withHidden, withoutHidden } from "./attention-model";
import { ATTENTION_READ_PERMISSIONS } from "./navigation";

describe("attention model", () => {
  test("any attention permission lets a person read the list", () => {
    for (const permission of ATTENTION_READ_PERMISSIONS)
      expect(canReadAttention([permission])).toBe(true);
    expect(canReadAttention([])).toBe(false);
  });

  test("hiding keeps the snapshot, restoring an unknown entry changes nothing", () => {
    const empty: ReadonlyMap<string, string> = new Map();
    const hidden = withHidden(empty, "a1", "snap-1");
    expect([...hidden]).toEqual([["a1", "snap-1"]]);
    expect(empty.size).toBe(0);
    expect(withHidden(hidden, "a1", "snap-2").get("a1")).toBe("snap-2");
    expect(withoutHidden(hidden, "missing")).toBe(hidden);
    expect(withoutHidden(hidden, "a1").size).toBe(0);
  });
});

describe("inboxCount", () => {
  test("counts the collected inbox entries the overview already knows", () => {
    expect(
      inboxCount([
        { reason: "intake_collected", counts: { intake: 8 } },
        { reason: "failing", counts: {} },
      ]),
    ).toBe(8);
  });

  test("an entry without a count stands for one, no entry for none", () => {
    expect(inboxCount([{ reason: "intake_collected", counts: {} }])).toBe(1);
    expect(inboxCount([])).toBe(0);
  });
});
