// Citation harvesting — deterministic.

import { describe, expect, test } from "bun:test";
import { harvestCitations } from "../citations.ts";
import type { TurnEvent } from "../types.ts";

const toolResult = (tool: string, output: unknown): TurnEvent =>
  ({ type: "tool_result", call_id: "c", tool, output }) as TurnEvent;

describe("harvestCitations", () => {
  test("extracts knowledge hits as citations, deduped by id", () => {
    const events: TurnEvent[] = [
      toolResult("search_knowledge", {
        ok: true,
        data: {
          hits: [
            { id: "k1", source_name: "Payments Guide", snippet: "take a payment" },
            { id: "k2", source_name: "Repo Guide", snippet: "list repositories" },
          ],
        },
      }),
      // search_knowledge_v2 re-surfaces k1 — must dedup.
      toolResult("search_knowledge_v2", {
        ok: true,
        data: { hits: [{ id: "k1", source_name: "Payments Guide" }] },
      }),
    ];
    const citations = harvestCitations(events);
    expect(citations.map((c) => c.id)).toEqual(["k1", "k2"]);
    expect(citations[0]).toEqual({
      source_type: "knowledge_chunk",
      id: "k1",
      source_name: "Payments Guide",
      excerpt: "take a payment",
    });
  });

  test("ignores non-grounding tools and malformed output", () => {
    const events: TurnEvent[] = [
      toolResult("list_workflows", { ok: true, data: { workflows: [{ id: "w1" }] } }),
      toolResult("search_knowledge", { ok: true, data: {} }),
      toolResult("search_knowledge", null),
      { type: "text_delta", text: "hi" } as TurnEvent,
    ];
    expect(harvestCitations(events)).toEqual([]);
  });

  test("no grounding tool → empty (a direct answer the prove-before gate must catch)", () => {
    expect(harvestCitations([{ type: "text_delta", text: "hi" } as TurnEvent])).toEqual([]);
  });
});
