// Contract: the terminal `citations` stream frame — engine Zod schema
// (CitationsEventSchema) and the cli-core TurnEvent variant it feeds — stay
// in lockstep.
//
// Honest scope note: citations (like `next_suggestion`) ride the SSE
// `events` array, typed `z.array(z.any())` at the OpenAPI boundary, so
// neither appears as an OpenAPI component (verified: NextSuggestionEvent is
// not a component either). The real contract for these frames is the
// engine-Zod ↔ cli-core-type agreement pinned below, not the OpenAPI spec.

import { describe, expect, test } from "bun:test";
import {
  CitationSchema,
  CitationsEventSchema,
} from "../../apps/engine/src/http/routes/conversations/schemas.ts";
import type { Citation } from "../../packages/cli-core/src/turn-event.ts";

describe("contract · citations frame engine↔cli-core lockstep", () => {
  test("a cli-core Citation (both source types) parses under the engine CitationSchema", () => {
    const knowledge: Citation = {
      source_type: "knowledge_chunk",
      id: "chunk-1",
      source_name: "Weather Runbook",
      excerpt: "…",
    };
    const connectorDoc: Citation = { source_type: "connector_doc", id: "doc-1" };
    expect(CitationSchema.safeParse(knowledge).success).toBe(true);
    expect(CitationSchema.safeParse(connectorDoc).success).toBe(true);
  });

  test("source_type is the exact final union — no third value slips through", () => {
    expect(CitationSchema.safeParse({ source_type: "execution_ref", id: "x" }).success).toBe(false);
  });

  test("the CitationsEvent frame shape matches the emitted TurnEvent variant", () => {
    const frame = {
      type: "citations" as const,
      citations: [{ source_type: "knowledge_chunk" as const, id: "chunk-1" }],
      parent_message_id: "a1",
    };
    expect(CitationsEventSchema.safeParse(frame).success).toBe(true);
    // parent_message_id is optional (client falls back to the last message).
    const { parent_message_id: _drop, ...noParent } = frame;
    expect(CitationsEventSchema.safeParse(noParent).success).toBe(true);
  });
});
