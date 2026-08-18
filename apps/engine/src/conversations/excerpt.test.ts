// The excerpt rules are shared by the conversation list and the auto-title.
// These cases pin the two properties that a second copy would break first:
// the same clipping behaviour at every length, and a file sentinel that never
// survives into human-facing text.

import { describe, expect, test } from "bun:test";
import { stringifyConversationExcerpt, truncateExcerpt } from "./excerpt.ts";

describe("truncateExcerpt", () => {
  test("squashes whitespace without clipping short text", () => {
    expect(truncateExcerpt("  build   the\n\nmonthly report ")).toBe("build the monthly report");
  });

  test("marks a clipped string with an ellipsis at every length", () => {
    const text = "a".repeat(200);
    expect(truncateExcerpt(text, 50)).toHaveLength(50);
    expect(truncateExcerpt(text, 50).endsWith("…")).toBe(true);
    expect(truncateExcerpt(text, 140)).toHaveLength(140);
    expect(truncateExcerpt(text, 140).endsWith("…")).toBe(true);
  });

  test("does not clip text that exactly fits", () => {
    const text = "b".repeat(50);
    expect(truncateExcerpt(text, 50)).toBe(text);
  });
});

describe("stringifyConversationExcerpt", () => {
  test("replaces a file sentinel so no raw fid reaches display text", () => {
    const excerpt = stringifyConversationExcerpt(
      "check [file:fid_11111111-2222-3333-4444-555555555555] please",
    );
    expect(excerpt).not.toContain("fid_");
    expect(excerpt).toContain("[file]");
  });

  test("prefers text, then summary, on an object payload", () => {
    expect(stringifyConversationExcerpt({ text: "from text" })).toBe("from text");
    expect(stringifyConversationExcerpt({ summary: "from summary" })).toBe("from summary");
  });

  test("returns null when there is nothing worth showing", () => {
    expect(stringifyConversationExcerpt("   ")).toBeNull();
    expect(stringifyConversationExcerpt(null)).toBeNull();
    expect(stringifyConversationExcerpt(undefined)).toBeNull();
    expect(stringifyConversationExcerpt({})).toBeNull();
  });
});
