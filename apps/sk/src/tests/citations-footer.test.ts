import { describe, expect, test } from "bun:test";
import type { Citation } from "@cli-core/index.ts";
import { formatCitationsFooter, terminalAssistantCitations } from "../lib/citations-footer.ts";

describe("formatCitationsFooter", () => {
  test("renders deduped display names", () => {
    const cites: Citation[] = [
      { source_type: "knowledge_chunk", id: "1", source_name: "Weather Runbook" },
      { source_type: "knowledge_chunk", id: "2", source_name: "GitHub API" },
      { source_type: "knowledge_chunk", id: "3", source_name: "Weather Runbook" },
    ];
    expect(formatCitationsFooter(cites)).toBe("Sources: Weather Runbook, GitHub API");
  });

  test("falls back to id when a source has no name", () => {
    expect(formatCitationsFooter([{ source_type: "connector_doc", id: "doc-42" }])).toBe(
      "Sources: doc-42",
    );
  });

  test("returns null for empty/absent → no footer on citation-less answers", () => {
    expect(formatCitationsFooter([])).toBeNull();
    expect(formatCitationsFooter(undefined)).toBeNull();
  });
});

describe("terminalAssistantCitations", () => {
  test("returns the LAST assistant message's citations", () => {
    const cites: Citation[] = [{ source_type: "knowledge_chunk", id: "x" }];
    const messages = [
      { role: "user" },
      { role: "assistant", citations: [{ source_type: "knowledge_chunk" as const, id: "old" }] },
      { role: "assistant", citations: cites },
    ];
    expect(terminalAssistantCitations(messages)).toBe(cites);
  });

  test("undefined when the last assistant message has none", () => {
    expect(terminalAssistantCitations([{ role: "assistant" }])).toBeUndefined();
    expect(terminalAssistantCitations([{ role: "user" }])).toBeUndefined();
  });
});
