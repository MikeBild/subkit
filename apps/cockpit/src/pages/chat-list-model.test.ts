import { describe, expect, test } from "bun:test";
import { clipTitle, conversationRow, TITLE_MAX } from "./chat-list-model";

const labels = (excerpt: string | null) => ({
  untitled: "Unbenannte Unterhaltung",
  status: "Aktiv",
  excerpt,
});

describe("conversationRow", () => {
  test("a real title wins, and the excerpt moves to the second line", () => {
    const row = conversationRow(
      { title: "Monatsreport reparieren", status: "active" },
      labels("…"),
    );
    expect(row).toEqual({ title: "Monatsreport reparieren", secondary: "…", named: true });
  });

  test("without a title the last message becomes the title rather than a placeholder", () => {
    // A row that says only "untitled" while an excerpt sits unused is the
    // complaint this model exists to answer.
    const row = conversationRow(
      { title: null, status: "active" },
      labels("Warum schlägt der GA4-Report fehl?"),
    );
    expect(row.title).toBe("Warum schlägt der GA4-Report fehl?");
    expect(row.named).toBe(false);
  });

  test("a borrowed title is never repeated on the second line", () => {
    const row = conversationRow({ title: null, status: "active" }, labels("Etwas kurzes"));
    expect(row.secondary).toBe("Aktiv");
  });

  test("a title identical to the excerpt does not print twice", () => {
    const row = conversationRow(
      { title: "Gleicher Text", status: "active" },
      labels("Gleicher Text"),
    );
    expect(row.secondary).toBe("Aktiv");
  });

  test("the placeholder is reached only when there is genuinely nothing to show", () => {
    const row = conversationRow({ title: null, status: "active" }, labels(null));
    expect(row.title).toBe("Unbenannte Unterhaltung");
  });

  test("whitespace-only values count as absent", () => {
    const row = conversationRow({ title: "   ", status: "active" }, labels("  "));
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
