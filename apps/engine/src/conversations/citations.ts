import { truncateForLlm } from "../tools/truncate.ts";
import type { TurnEvent } from "./types.ts";

function stripSnippetMarkup(snippet: string): string {
  return snippet.replace(/<\/?b>/g, "");
}

export interface Citation {
  source_type: "knowledge_chunk" | "connector_doc" | "product_doc";
  id: string;
  source_name?: string;
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

interface DocHit {
  id: string;
  source?: string;
  heading?: string;
  title?: string | null;
  path?: string | null;
  snippet?: string;
}

function isDocHit(v: unknown): v is DocHit {
  return typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string";
}

export function harvestCitations(events: ReadonlyArray<TurnEvent>): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    if (ev.type !== "tool_result") continue;
    const output = ev.output as { hits?: unknown } | null;
    const hits = output?.hits;
    if (!Array.isArray(hits)) continue;

    if (ev.tool === "search_knowledge") {
      for (const h of hits) {
        if (!isKnowledgeHit(h)) continue;
        const key = `knowledge_chunk:${h.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          source_type: "knowledge_chunk",
          id: h.id,
          ...(h.source_name ? { source_name: h.source_name } : {}),
          ...(h.snippet ? { excerpt: stripSnippetMarkup(h.snippet).slice(0, 200) } : {}),
        });
      }
    } else if (ev.tool === "fetch_connector_docs" || ev.tool === "search_docs") {
      for (const h of hits) {
        if (!isDocHit(h)) continue;
        const sourceType = h.source === "product_docs" ? "product_doc" : "connector_doc";
        const key = `${sourceType}:${h.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const docName =
          sourceType === "product_doc" && h.title && h.heading && h.heading !== h.title
            ? `${h.title} › ${h.heading}`
            : h.title || h.path || undefined;
        out.push({
          source_type: sourceType,
          id: h.id,
          ...(docName ? { source_name: docName } : {}),
          ...(h.snippet ? { excerpt: stripSnippetMarkup(h.snippet).slice(0, 200) } : {}),
        });
      }
    }
  }
  return out;
}

export function harvestCitationsFromPersisted(events: ReadonlyArray<TurnEvent>): Citation[] {
  const modelVisible = events.map((ev) => {
    if (ev.type !== "tool_result") return ev;
    const t = truncateForLlm(ev.output, undefined, { store: false });
    return t.truncated ? ({ ...ev, output: t.data } as TurnEvent) : ev;
  });
  return harvestCitations(modelVisible);
}
