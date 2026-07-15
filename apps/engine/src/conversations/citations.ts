// Citation harvesting — the "prove-after" half of the grounding contract.
//
// Subkit's answers must be auditable to their sources. This walks a turn's
// `tool_result` events and extracts the structured source refs the grounding
// tools already return, so the loop can mirror them into the audit log —
// "this answer ← these sources" — without the model re-stating them in prose.
//
// v1 covers knowledge-source hits (search_knowledge / search_knowledge_v2),
// the clearest and highest-value grounding source: each hit already carries
// a chunk id, its source name, and a snippet — exactly a citation. Execution
// and connector-call refs are a natural extension (same shape) once their
// output envelopes are harvested.

import type { TurnEvent } from "./types.ts";

export interface Citation {
  /** `knowledge_chunk` = a Knowledge-Source hit; `connector_doc` = a
   *  connector-documentation hit (added when connector-doc harvesting
   *  lands). The union is declared final up front so downstream types,
   *  the Zod schema, and the cli-core mirror never re-widen. */
  source_type: "knowledge_chunk" | "connector_doc";
  /** The chunk id — resolvable via the knowledge source or connector docs. */
  id: string;
  /** Human-readable source name (display name of the source). */
  source_name?: string;
  /** A short excerpt of the cited text. */
  excerpt?: string;
}

interface KnowledgeHit {
  id: string;
  source_name?: string;
  snippet?: string;
}

function isKnowledgeHit(v: unknown): v is KnowledgeHit {
  return typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string";
}

/**
 * Harvest citations from a turn's events. Dedupes by (source_type, id).
 * Returns `[]` when the turn used no grounding tool — i.e. a direct answer
 * with no source, which the prove-before gate is responsible for catching.
 */
export function harvestCitations(events: ReadonlyArray<TurnEvent>): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    if (ev.type !== "tool_result") continue;
    // Only knowledge retrieval tools carry citation-shaped hits.
    if (ev.tool !== "search_knowledge" && ev.tool !== "search_knowledge_v2") continue;
    const output = ev.output as { data?: { hits?: unknown } } | null;
    const hits = output?.data?.hits;
    if (!Array.isArray(hits)) continue;
    for (const h of hits) {
      if (!isKnowledgeHit(h)) continue;
      const key = `knowledge_chunk:${h.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        source_type: "knowledge_chunk",
        id: h.id,
        ...(h.source_name ? { source_name: h.source_name } : {}),
        ...(h.snippet ? { excerpt: h.snippet.slice(0, 200) } : {}),
      });
    }
  }
  return out;
}
