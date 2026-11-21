import { type SQL, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import {
  embeddingsAvailable,
  fuseVectorFirst,
  vectorScoreCandidates,
} from "../embeddings/index.ts";
import type { KnowledgeSearchHit, SearchKnowledgeParams } from "./types.ts";

const KNOWLEDGE_VECTOR_SCAN_CAP = 2000;
export async function fuseKnowledgeWithVectors(
  db: Executor,
  p: SearchKnowledgeParams,
  hits: KnowledgeSearchHit[],
  scopeFilter: SQL,
  limit: number,
): Promise<KnowledgeSearchHit[]> {
  if (!(await embeddingsAvailable())) return hits;
  const out = await db.execute(sql`
    SELECT
      kc.id::text AS id,
      kc.knowledge_source_id::text AS knowledge_source_id,
      ks.name AS source_name,
      ks.tags AS source_tags,
      ks.description AS source_description,
      kc.title,
      kc.path,
      COALESCE(ks.last_refreshed_at, ks.updated_at) AS fetched_at,
      kc.content AS content,
      kc.embedding AS embedding
    FROM knowledge_chunks kc
    JOIN knowledge_sources ks ON ks.id = kc.knowledge_source_id
    WHERE kc.tenant_id = ${p.tenant_id}
      AND kc.embedding IS NOT NULL
      ${scopeFilter}
    ORDER BY kc.created_at DESC
    LIMIT ${KNOWLEDGE_VECTOR_SCAN_CAP}
  `);
  type ScopeRow = {
    id: string;
    knowledge_source_id: string;
    source_name: string;
    source_tags: string[] | null;
    source_description: string | null;
    title: string | null;
    path: string | null;
    fetched_at: Date | string | null;
    content: string;
    embedding: number[] | null;
  };
  const scopeRows = (out as unknown as { rows: ScopeRow[] }).rows ?? (out as unknown as ScopeRow[]);
  const scored = await vectorScoreCandidates(
    p.query,
    scopeRows.map((r) => ({ item: r, embedding: r.embedding })),
  );
  if (scored.length === 0) return hits;
  const byId = new Map(hits.map((h) => [h.id, h]));
  const vector = scored.map((s) => {
    const existing = byId.get(s.item.id);
    const hit: KnowledgeSearchHit = existing ?? {
      id: s.item.id,
      knowledge_source_id: s.item.knowledge_source_id,
      source_name: s.item.source_name,
      source_tags: s.item.source_tags ?? [],
      source_description: s.item.source_description,
      title: s.item.title,
      path: s.item.path,
      snippet: s.item.content.slice(0, 200),
      rank: s.cosine,
      fetched_at:
        s.item.fetched_at instanceof Date
          ? s.item.fetched_at.toISOString()
          : typeof s.item.fetched_at === "string"
            ? s.item.fetched_at
            : null,
    };
    return { item: hit, cosine: s.cosine };
  });
  return fuseVectorFirst({ fts: hits, vector, idOf: (h) => h.id, limit });
}
