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

  test("stops at a word boundary rather than mid-word", () => {
    const clipped = truncateExcerpt(
      "Reauthenticate the existing Anthropic connector bound to dev",
      50,
    );
    expect(clipped).toBe("Reauthenticate the existing Anthropic connector…");
    expect(clipped.length).toBeLessThanOrEqual(50);
  });

  test("refuses a back-off that would spend more than half the budget", () => {
    const clipped = truncateExcerpt(`go ${"x".repeat(80)}`, 40);
    expect(clipped.startsWith("go x")).toBe(true);
    expect(clipped).toHaveLength(40);
  });

  test("never exceeds max, whatever the boundary", () => {
    const text = "one two three four five six seven eight nine ten eleven twelve";
    for (const max of [5, 12, 20, 33, 50]) {
      expect(truncateExcerpt(text, max).length).toBeLessThanOrEqual(max);
    }
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
