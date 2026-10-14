import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  documentUnderTitle,
  knowledgeSummary,
  knowledgeWorkflowId,
  knowledgeWorkflowTarget,
  REFRESH_CRON,
  refreshFields,
  refreshRhythm,
  sourceKind,
  sourcePrimaryAction,
  sourceSections,
} from "./knowledge-sources-model";

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
  test("a workflow usage target requires the persisted workflow scope and matching workflow record", () => {
    expect(knowledgeWorkflowId("workflow", "wf-1")).toBe("wf-1");
    expect(knowledgeWorkflowId("global", "wf-1")).toBeNull();
    expect(knowledgeWorkflowId("workflow", null)).toBeNull();
    expect(knowledgeWorkflowId("workflow", " ")).toBeNull();
    expect(
      knowledgeWorkflowTarget("workflow", "wf-1", { id: "wf-1", name: "Daily report" }),
    ).toEqual({ id: "wf-1", name: "Daily report" });
    expect(knowledgeWorkflowTarget("workflow", "wf-1", { id: "wf-2", name: "Other" })).toBeNull();
    expect(knowledgeWorkflowTarget("workflow", "wf-1", null)).toBeNull();
    expect(
      knowledgeWorkflowTarget("global", null, { id: "wf-1", name: "Daily report" }),
    ).toBeNull();
  });

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

describe("knowledge summary", () => {
  const de = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate("de", key, values);
  test("uses the complete source and section totals", () => {
    expect(knowledgeSummary(51, 345, de)).toBe("51 Quellen · 345 Abschnitte");
    expect(knowledgeSummary(1, 1, de)).toBe("1 Quelle · 1 Abschnitt");
    expect(knowledgeSummary(2, 0, de)).toBe("2 Quellen · 0 Abschnitte");
  });
  test("does not invent a section total when the API has not provided it", () => {
    expect(knowledgeSummary(51, undefined, de)).toBe("51 Quellen");
    expect(knowledgeSummary(51, Number.NaN, de)).toBe("51 Quellen");
  });
});
