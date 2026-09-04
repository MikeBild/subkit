import { describe, expect, test } from "bun:test";
import { clipTitle, conversationRow, TITLE_MAX } from "./chat-list-model";

const labels = (excerpt: string | null) => ({
  untitled: "Unbenannte Unterhaltung",
  excerpt,
});

describe("conversationRow", () => {
  test("a titled row says the title and nothing else", () => {
    const row = conversationRow({ title: "Monatsreport reparieren" }, labels("…"));
    expect(row).toEqual({
      title: "Monatsreport reparieren",
      secondary: null,
      named: true,
      waiting: false,
    });
  });

  test("the last thing said never becomes the second line", () => {
    const row = conversationRow(
      { title: "Report prüfen" },
      labels("Validation result: ok: false, 3 steps skipped"),
    );
    expect(row.secondary).toBeNull();
  });

  test("the object the conversation is about beats the last thing said", () => {
    const row = conversationRow(
      {
        title: "Report prüfen",
        target_workflow: { name: "Monatsreport", slug: "monatsreport" },
      },
      labels("Ich habe die Transformation eingegrenzt."),
    );
    expect(row.secondary).toBe("Monatsreport");
  });

  test("a target without a display name falls back to its slug, never an id", () => {
    const row = conversationRow(
      { title: "Report prüfen", target_connector: { name: null, slug: "reporting-api" } },
      labels(null),
    );
    expect(row.secondary).toBe("reporting-api");
  });

  test("without a title the last message becomes the title rather than a placeholder", () => {
    const row = conversationRow({ title: null }, labels("Warum schlägt der GA4-Report fehl?"));
    expect(row.title).toBe("Warum schlägt der GA4-Report fehl?");
    expect(row.named).toBe(false);
  });

  test("the status word never appears: a borrowed title has no second line", () => {
    const row = conversationRow({ title: null, outcome: "answered" }, labels("Etwas kurzes"));
    expect(row.secondary).toBeNull();
  });

  test("a title identical to the excerpt does not print twice", () => {
    const row = conversationRow({ title: "Gleicher Text" }, labels("Gleicher Text"));
    expect(row.secondary).toBeNull();
  });

  test("a waiting conversation is flagged so the row can mark it", () => {
    expect(conversationRow({ title: "x", outcome: "awaiting_you" }, labels(null)).waiting).toBe(
      true,
    );
    expect(conversationRow({ title: "x", outcome: "answered" }, labels(null)).waiting).toBe(false);
  });

  test("the placeholder is reached only when there is genuinely nothing to show", () => {
    const row = conversationRow({ title: null }, labels(null));
    expect(row.title).toBe("Unbenannte Unterhaltung");
    expect(row.secondary).toBeNull();
  });

  test("whitespace-only values count as absent", () => {
    const row = conversationRow({ title: "   " }, labels("  "));
    expect(row.title).toBe("Unbenannte Unterhaltung");
  });
});

describe("clipTitle", () => {
  test("clips at a word boundary and marks the cut", () => {
    const clipped = clipTitle(`${"wort ".repeat(40)}ende`);
    expect(clipped.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped.endsWith(" …")).toBe(false);
  });

  test("does not clip text that fits, and squashes whitespace", () => {
    expect(clipTitle("kurz   und\n gut")).toBe("kurz und gut");
  });

  test("a single very long word is still cut rather than overflowing", () => {
    expect(clipTitle("a".repeat(200)).length).toBe(TITLE_MAX);
  });
});
