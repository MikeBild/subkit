import { describe, expect, test } from "bun:test";
import { distinctSourceCount, noteStatus } from "./status.ts";

const AT = new Date("2026-11-01T10:00:00Z");

describe("noteStatus", () => {
  test.each([
    [{ confirmed_at: AT, origin: "inferred", distinct_source_count: 0 }, "confirmed"],
    [{ confirmed_at: AT, origin: "stated", distinct_source_count: 5 }, "confirmed"],
    [{ confirmed_at: null, origin: "stated", distinct_source_count: 0 }, "mentioned_once"],
    [{ confirmed_at: null, origin: "stated", distinct_source_count: 1 }, "mentioned_once"],
    [{ confirmed_at: null, origin: "stated", distinct_source_count: 2 }, "learned"],
    [{ confirmed_at: null, origin: "inferred", distinct_source_count: 2 }, "mentioned_once"],
    [{ confirmed_at: null, origin: "inferred", distinct_source_count: 3 }, "learned"],
  ] as const)("%j is %s", (note, expected) => {
    expect(noteStatus(note)).toBe(expected);
  });
});

describe("distinctSourceCount", () => {
  test("counts conversations once, however many messages cite them", () => {
    expect(
      distinctSourceCount([
        { conversation_id: "c1", message_id: "m1" },
        { conversation_id: "c1", message_id: "m2" },
        { conversation_id: "c2", message_id: "m3" },
      ]),
    ).toBe(2);
  });

  test("a source whose conversation is gone still counts by its message, or alone", () => {
    expect(
      distinctSourceCount([
        { conversation_id: null, message_id: "m1" },
        { conversation_id: null, message_id: "m1" },
        { conversation_id: null, message_id: null },
        { conversation_id: null, message_id: null },
      ]),
    ).toBe(3);
  });

  test("no sources count as zero", () => {
    expect(distinctSourceCount([])).toBe(0);
  });
});
