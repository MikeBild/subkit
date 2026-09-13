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
    // No spaces at all: the word-boundary preference has nothing to prefer, so
    // the clip is hard and lands exactly on the budget.
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
    // The case that shipped to production: a 50-char title cut "bound" to "b".
    const clipped = truncateExcerpt(
      "Reauthenticate the existing Anthropic connector bound to dev",
      50,
    );
    expect(clipped).toBe("Reauthenticate the existing Anthropic connector…");
    expect(clipped.length).toBeLessThanOrEqual(50);
  });

  test("refuses a back-off that would spend more than half the budget", () => {
    // One short word, then an unbroken run. Backing off to that space would
    // return "go…" and throw away everything the reader came for.
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
