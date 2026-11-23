import { describe, expect, test } from "bun:test";
import { answerSources } from "./citations";

describe("answerSources", () => {
  test("a message without citations has no sources", () => {
    expect(answerSources({ id: "m1" })).toEqual({ shown: [], more: 0 });
    expect(answerSources({ citations: "nope" })).toEqual({ shown: [], more: 0 });
    expect(answerSources(null)).toEqual({ shown: [], more: 0 });
  });

  test("several passages of one knowledge source show as one source", () => {
    const { shown, more } = answerSources({
      citations: [
        { source_type: "knowledge_chunk", id: "c1", source_name: "Refund Policy" },
        { source_type: "knowledge_chunk", id: "c2", source_name: "refund policy " },
      ],
    });
    expect(more).toBe(0);
    expect(shown).toEqual([
      { key: "knowledge:refund policy", kind: "knowledge", label: "Refund Policy", path: null },
    ]);
  });

  test("a source that was read in full and a loaded skill link to their pages", () => {
    const { shown } = answerSources({
      citations: [
        { source_type: "knowledge_chunk", id: "c1", source_name: "Runbook" },
        { source_type: "knowledge_source", id: "ks 1", source_name: "Runbook" },
        { source_type: "skill", id: "sk-1", source_name: "Refunds" },
      ],
    });
    expect(shown).toEqual([
      { key: "knowledge:runbook", kind: "knowledge", label: "Runbook", path: "/knowledge/ks%201" },
      { key: "skill:refunds", kind: "skill", label: "Refunds", path: "/skills/sk-1" },
    ]);
  });

  test("documentation hits are named but not linked, and unnamed ones stay apart", () => {
    const { shown } = answerSources({
      citations: [
        { source_type: "connector_doc", id: "d1", source_name: "Orders API" },
        { source_type: "product_doc", id: "d2" },
        { source_type: "product_doc", id: "d3" },
      ],
    });
    expect(shown.map((source) => [source.kind, source.label, source.path])).toEqual([
      ["docs", "Orders API", null],
      ["docs", null, null],
      ["docs", null, null],
    ]);
  });

  test("unknown kinds and broken entries are ignored", () => {
    expect(
      answerSources({
        citations: [null, { source_type: "execution", id: "x" }, { source_type: "skill" }],
      }),
    ).toEqual({ shown: [], more: 0 });
  });

  test("only the first five sources are shown and the rest is counted", () => {
    const citations = Array.from({ length: 8 }, (_, i) => ({
      source_type: "knowledge_chunk",
      id: `c${i}`,
      source_name: `Source ${i}`,
    }));
    const { shown, more } = answerSources({ citations });
    expect(shown).toHaveLength(5);
    expect(more).toBe(3);
  });
});
