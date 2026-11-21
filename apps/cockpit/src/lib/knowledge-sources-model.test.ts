import { describe, expect, test } from "bun:test";
import {
  documentUnderTitle,
  matchesEndpoint,
  openApiEndpoints,
  RAW_PREVIEW_CHARACTERS,
  REFRESH_CRON,
  rawPreview,
  refreshFields,
  refreshRhythm,
  sourceKind,
  sourcePrimaryAction,
  sourceSections,
} from "@/lib/knowledge-sources-model";

describe("sourcePrimaryAction", () => {
  test("a text source is edited, an address is read again, the rest has no primary action", () => {
    expect(sourcePrimaryAction(sourceKind("inline"))).toBe("edit");
    expect(sourcePrimaryAction(sourceKind("url"))).toBe("refresh");
    expect(sourcePrimaryAction(sourceKind("file"))).toBeNull();
    expect(sourcePrimaryAction(sourceKind("bundle"))).toBeNull();
  });
});

describe("refreshRhythm", () => {
  test("reads the offered rhythms back from the engine's fields", () => {
    expect(refreshRhythm("manual", null)).toBe("never");
    expect(refreshRhythm("scheduled", REFRESH_CRON.daily)).toBe("daily");
    expect(refreshRhythm("scheduled", " 0 6  * * 1 ")).toBe("weekly");
  });

  test("a rhythm set elsewhere stays honest, never a nearby offer", () => {
    expect(refreshRhythm("scheduled", "0 9 * * *")).toBe("custom");
    expect(refreshRhythm("scheduled", "every:3600")).toBe("custom");
    expect(refreshRhythm("webhook", null)).toBe("custom");
  });

  test("each offered rhythm round-trips through the fields it writes", () => {
    for (const rhythm of ["never", "daily", "weekly"] as const) {
      const fields = refreshFields(rhythm);
      expect(refreshRhythm(fields.refresh_strategy, fields.refresh_cron)).toBe(rhythm);
    }
  });
});

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
    expect(sourceKind("discovery_endpoint_index")).toBe("discovered");
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

describe("openApiEndpoints", () => {
  const spec = JSON.stringify({
    openapi: "3.0.3",
    paths: {
      "/orgs/{org}/repos": {
        get: { summary: "List organization repositories", operationId: "repos/list-for-org" },
        post: { description: "Create a repository\nfor the organization" },
      },
      "/": { get: { operationId: "meta/root" }, parameters: [] },
    },
  });

  test("lists every operation with method, path and a plain purpose", () => {
    const endpoints = openApiEndpoints([spec]);
    expect(endpoints?.map((entry) => [entry.method, entry.path, entry.purpose])).toEqual([
      ["GET", "/orgs/{org}/repos", "List organization repositories"],
      ["POST", "/orgs/{org}/repos", "Create a repository"],
      ["GET", "/", "meta/root"],
    ]);
  });

  test("reads a description split across sections", () => {
    const cut = Math.floor(spec.length / 2);
    expect(openApiEndpoints([spec.slice(0, cut), spec.slice(cut)])?.length).toBe(3);
  });

  test("anything else is not an interface description", () => {
    expect(openApiEndpoints(["# Handbuch"])).toBeNull();
    expect(openApiEndpoints(['{"name":"x","paths":{}}'])).toBeNull();
    expect(openApiEndpoints(["{broken"])).toBeNull();
  });

  test("search matches method, path and purpose", () => {
    const [first] = openApiEndpoints([spec]) ?? [];
    if (!first) throw new Error("missing endpoint");
    expect(matchesEndpoint(first, "organization")).toBe(true);
    expect(matchesEndpoint(first, "get /orgs")).toBe(true);
    expect(matchesEndpoint(first, "delete")).toBe(false);
  });
});

describe("rawPreview", () => {
  test("keeps short content whole and cuts long content", () => {
    expect(rawPreview(["a", "b"])).toEqual({ text: "a\n\nb", truncated: false });
    const long = rawPreview(["x".repeat(RAW_PREVIEW_CHARACTERS + 5)]);
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBe(RAW_PREVIEW_CHARACTERS);
  });
});
