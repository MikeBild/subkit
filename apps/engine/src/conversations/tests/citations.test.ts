// Citation harvesting — deterministic.
//
// `tool_result.output` fixtures here use the FLAT shape a real turn
// actually produces: `normalizeToolResultPayload`
// (conversations/tools/result-payload.ts) unwraps a successful
// `ToolResult` down to its `.data` before the event is built, so `output`
// is `{ hits: [...] }`, never `{ ok: true, data: { hits: [...] } }`. An
// e2e run through the mock LLM provider caught the drift when the earlier
// fixtures here (wrapped in `{ok, data}`) kept this suite green while the
// live event never carried a harvestable shape at all.

import { describe, expect, test } from "bun:test";
import { harvestCitations, harvestCitationsFromPersisted } from "../citations.ts";
import type { TurnEvent } from "../types.ts";

const toolResult = (tool: string, output: unknown): TurnEvent =>
  ({ type: "tool_result", call_id: "c", tool, output }) as TurnEvent;

describe("harvestCitations", () => {
  test("extracts knowledge hits as citations, deduped by id", () => {
    const events: TurnEvent[] = [
      toolResult("search_knowledge", {
        hits: [
          { id: "k1", source_name: "Payments Guide", snippet: "take a payment" },
          { id: "k2", source_name: "Repo Guide", snippet: "list repositories" },
        ],
      }),
      // search_knowledge_v2 re-surfaces k1 — must dedup.
      toolResult("search_knowledge_v2", { hits: [{ id: "k1", source_name: "Payments Guide" }] }),
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
      toolResult("list_workflows", { workflows: [{ id: "w1" }] }),
      toolResult("search_knowledge", {}),
      toolResult("search_knowledge", null),
      { type: "text_delta", text: "hi" } as TurnEvent,
    ];
    expect(harvestCitations(events)).toEqual([]);
  });

  test("no grounding tool → empty (a direct answer the prove-before gate must catch)", () => {
    expect(harvestCitations([{ type: "text_delta", text: "hi" } as TurnEvent])).toEqual([]);
  });

  test("extracts connector-doc hits (title→source_name, snippet→excerpt), deduped", () => {
    const events: TurnEvent[] = [
      toolResult("fetch_connector_docs", {
        hits: [
          { id: "d1", title: "Stripe · Charges", snippet: "POST /v1/charges" },
          { id: "d2", title: "Stripe · Refunds", snippet: "POST /v1/refunds" },
        ],
      }),
      // search_docs re-surfaces d1 — must dedup.
      toolResult("search_docs", { hits: [{ id: "d1", title: "Stripe · Charges" }] }),
    ];
    const citations = harvestCitations(events);
    expect(citations.map((c) => c.id)).toEqual(["d1", "d2"]);
    expect(citations[0]).toEqual({
      source_type: "connector_doc",
      id: "d1",
      source_name: "Stripe · Charges",
      excerpt: "POST /v1/charges",
    });
  });

  test("mixes knowledge and connector-doc citations from one turn", () => {
    const events: TurnEvent[] = [
      toolResult("search_knowledge", { hits: [{ id: "k1" }] }),
      toolResult("fetch_connector_docs", { hits: [{ id: "d1" }] }),
    ];
    const kinds = harvestCitations(events).map((c) => c.source_type);
    expect(kinds).toEqual(["knowledge_chunk", "connector_doc"]);
  });

  test("strips ts_headline <b> highlight markup from excerpts (both kinds)", () => {
    // Postgres ts_headline wraps matched terms in <b>…</b>; the excerpt must
    // be faithful source text so the anti-drift quote check can match a
    // verbatim quote against it.
    const events: TurnEvent[] = [
      toolResult("search_knowledge", {
        hits: [{ id: "k1", source_name: "S", snippet: "to <b>create</b> a <b>customer</b>" }],
      }),
      toolResult("search_docs", {
        hits: [{ id: "d1", title: "T", snippet: "POST <b>/customers</b>" }],
      }),
    ];
    const cites = harvestCitations(events);
    expect(cites[0]?.excerpt).toBe("to create a customer");
    expect(cites[1]?.excerpt).toBe("POST /customers");
  });
});

describe("harvestCitationsFromPersisted", () => {
  test("matches the live harvest for normal-size grounding output", () => {
    const events: TurnEvent[] = [
      toolResult("search_knowledge", {
        hits: [{ id: "k1", source_name: "S", snippet: "hello" }],
      }),
    ];
    expect(harvestCitationsFromPersisted(events)).toEqual(harvestCitations(events));
  });

  test("reproduces the model-visible array cap on a large payload (no over-count)", () => {
    // 40 hits push the persisted output past the char cap; the model-visible
    // truncation caps the array (to well under 40) yet keeps the hits inline,
    // so the replay footer names the same capped set the model saw — not all
    // 40 sources.
    const hits = Array.from({ length: 40 }, (_, i) => ({
      id: `k${i}`,
      source_name: `Source ${i}`,
      snippet: "x".repeat(200),
    }));
    const events: TurnEvent[] = [toolResult("search_knowledge", { hits })];
    const cites = harvestCitationsFromPersisted(events);
    expect(cites.length).toBeGreaterThan(0);
    expect(cites.length).toBeLessThan(40);
  });
});
