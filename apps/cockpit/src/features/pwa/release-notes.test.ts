import { describe, expect, test } from "bun:test";
import { releaseNotesFor } from "./release-notes";

describe("release notes in English", () => {
  const highlights = ["A vault for every credential"];
  const notes = ["subkit runs on your mac"];

  test("a version with highlights shows them", () => {
    expect(releaseNotesFor({ notes, highlights })).toEqual({
      source: "highlights",
      notes: highlights,
    });
  });

  test("a version without highlights falls back to the commit subjects", () => {
    expect(releaseNotesFor({ notes, highlights: null })).toEqual({ source: "commits", notes });
    expect(releaseNotesFor({ notes, highlights: [] }).source).toBe("commits");
  });
});
