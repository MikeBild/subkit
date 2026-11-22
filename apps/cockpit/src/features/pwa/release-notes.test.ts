import { describe, expect, test } from "bun:test";
import { releaseNotesFor } from "./release-notes";

describe("release notes in the user's language", () => {
  const highlights = { de: ["Tresor für alle Zugänge"], en: ["A vault for every credential"] };
  const notes = ["subkit runs on your mac"];

  test("a version with highlights shows them in the user's language", () => {
    expect(releaseNotesFor({ notes, highlights }, "de")).toEqual({
      source: "highlights",
      notes: ["Tresor für alle Zugänge"],
    });
    expect(releaseNotesFor({ notes, highlights }, "en")).toEqual({
      source: "highlights",
      notes: ["A vault for every credential"],
    });
  });

  test("a version without highlights falls back to the commit subjects", () => {
    expect(releaseNotesFor({ notes, highlights: null }, "de")).toEqual({
      source: "commits",
      notes,
    });
    expect(releaseNotesFor({ notes, highlights: { de: [], en: [] } }, "en").source).toBe("commits");
  });
});
