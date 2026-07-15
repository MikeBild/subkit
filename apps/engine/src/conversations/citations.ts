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

import { truncateForLlm } from "./tools/truncate.ts";
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

/** Connector-doc `SearchHit` (docs-ingestion) — id is the doc-chunk id,
 *  `title`/`snippet` map to source_name/excerpt. A different envelope from
 *  KnowledgeHit, so it gets its own guard + mapping. */
interface DocHit {
  id: string;
  title?: string | null;
  snippet?: string;
}

function isDocHit(v: unknown): v is DocHit {
  return typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string";
}

/**
 * Harvest citations from a turn's events. Dedupes by (source_type, id).
 * Returns `[]` when the turn used no grounding tool — i.e. a direct answer
 * with no source, which the prove-before gate is responsible for catching.
 *
 * Covers Knowledge-Source hits (`search_knowledge*` → knowledge_chunk) and
 * connector-documentation hits (`fetch_connector_docs`/`search_docs` →
 * connector_doc). Every harvested kind MUST have a matching resolve branch
 * in `source-faithful.ts` — a harvested-but-unresolvable id would let a
 * fabricated citation pass the anti-drift gate.
 */
export function harvestCitations(events: ReadonlyArray<TurnEvent>): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    if (ev.type !== "tool_result") continue;
    // `ev.output` is already the unwrapped `ToolResult.data` payload by the
    // time a tool_result event exists — `normalizeToolResultPayload`
    // (conversations/tools/result-payload.ts) strips the `{ok, data}`
    // envelope before persisting/streaming a successful call, and every
    // grounding tool's `execute()` returns `{ ok: true, data: { hits } }`.
    // Reading `output.data.hits` here would never match a live event.
    const output = ev.output as { hits?: unknown } | null;
    const hits = output?.hits;
    if (!Array.isArray(hits)) continue;

    if (ev.tool === "search_knowledge" || ev.tool === "search_knowledge_v2") {
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
    } else if (ev.tool === "fetch_connector_docs" || ev.tool === "search_docs") {
      for (const h of hits) {
        if (!isDocHit(h)) continue;
        const key = `connector_doc:${h.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          source_type: "connector_doc",
          id: h.id,
          ...(h.title ? { source_name: h.title } : {}),
          ...(h.snippet ? { excerpt: h.snippet.slice(0, 200) } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * Replay-safe harvest. The live loop harvests from the MODEL-VISIBLE
 * (truncated) tool output, but the persisted `tool_result` output is the
 * FULL payload — so re-deriving citations on replay from the raw persisted
 * output would name MORE sources than the live footer for a grounding call
 * that returned more hits than the model was shown. Reproduce the exact
 * model-visible view with the same truncation the loop applied, so a
 * replayed transcript's footer matches the live one. (No grounding tool is
 * truncation-exempt — only `get_raw_result` is, and it is never harvested.)
 */
export function harvestCitationsFromPersisted(events: ReadonlyArray<TurnEvent>): Citation[] {
  const modelVisible = events.map((ev) => {
    if (ev.type !== "tool_result") return ev;
    const t = truncateForLlm(ev.output);
    return t.truncated ? ({ ...ev, output: t.data } as TurnEvent) : ev;
  });
  return harvestCitations(modelVisible);
}
