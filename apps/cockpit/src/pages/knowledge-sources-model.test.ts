import { describe, expect, test } from "bun:test";
import { documentUnderTitle, sourceKind, sourceSections } from "./knowledge-sources-model";

const chunk = (
  ordinal: number,
  content: string,
  title: string | null = null,
  path: string | null = null,
) => ({
  ordinal,
  title,
  path,
  content,
  byte_size: content.length,
});

describe("knowledge sources as a reader sees them", () => {
  test("the engine's source types read as four kinds", () => {
    expect(sourceKind("url")).toBe("url");
    expect(sourceKind("inline")).toBe("text");
    expect(sourceKind("bundle")).toBe("bundle");
    expect(sourceKind("seed")).toBe("bundle");
    expect(sourceKind("file_upload")).toBe("file");
  });

  test("chunks of one path are one section, in stored order", () => {
    const sections = sourceSections([
      chunk(2, "b2", null, "/b.md"),
      chunk(0, "a1", "Alpha", "/a.md"),
      chunk(1, "a2", null, "/a.md"),
    ]);
    expect(sections.map((section) => section.title)).toEqual(["Alpha", "/b.md"]);
    expect(sections[0]?.content).toBe("a1\n\na2");
    expect(sections[0]?.bytes).toBe(4);
  });

  test("without paths a titled chunk starts a section and untitled ones continue it", () => {
    const sections = sourceSections([
      chunk(0, "intro", "Einleitung"),
      chunk(1, "more"),
      chunk(2, "x", "Preise"),
    ]);
    expect(sections.map((section) => [section.title, section.content])).toEqual([
      ["Einleitung", "intro\n\nmore"],
      ["Preise", "x"],
    ]);
  });

  test("a first untitled chunk gets a numbered title, never an empty one", () => {
    expect(sourceSections([chunk(0, "only")])[0]?.title).toBe("#1");
  });
});

describe("a document under a record's title", () => {
  test("drops a leading heading that repeats the title and demotes the rest", () => {
    expect(
      documentUnderTitle("# Sichere Reports\n\nText\n\n# Regeln\n## Mehr", "Sichere Reports"),
    ).toBe("Text\n\n## Regeln\n### Mehr");
  });

  test("keeps a different first heading, one level down, and leaves fenced code alone", () => {
    expect(documentUnderTitle("# Andere\n```\n# kein Titel\n```", "Titel")).toBe(
      "## Andere\n```\n# kein Titel\n```",
    );
  });
});
