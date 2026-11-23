import { type SQL, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import {
  cosineSimilarity,
  embedQuery,
  type QueryEmbedder,
  VECTOR_MIN_COSINE,
} from "../embeddings/index.ts";
import { logger } from "../logging/index.ts";
import { bestPassage } from "./core/passage.ts";
import { fuseByReciprocalRank, keepTopScored } from "./core/rank-fusion.ts";
import type { KnowledgeSearchHit, SearchKnowledgeParams } from "./types.ts";

const VECTOR_SCAN_BATCH = 500;
export const KNOWLEDGE_VECTOR_SCAN_CEILING = 20_000;
const VECTOR_TOP = 50;

type ScanRow = {
  id: string;
  knowledge_source_id: string;
  ordinal: number;
  embedding: number[] | null;
};

type WinnerRow = {
  id: string;
  knowledge_source_id: string;
  source_name: string;
  source_tags: string[] | null;
  source_description: string | null;
  title: string | null;
  path: string | null;
  fetched_at: Date | string | null;
  content: string;
};

function rowsOf<T>(out: unknown): T[] {
  return (out as { rows?: T[] }).rows ?? (out as T[]);
}

async function scanTopVectors(
  db: Executor,
  tenant_id: string,
  scopeFilter: SQL,
  queryVector: readonly number[],
  opts: { batch: number; ceiling: number },
): Promise<Array<{ item: string; score: number }>> {
  const top: Array<{ item: string; score: number }> = [];
  let after: ScanRow | null = null;
  let scanned = 0;
  for (;;) {
    const keyset: SQL = after
      ? sql`AND (kc.knowledge_source_id, kc.ordinal, kc.id) > (${after.knowledge_source_id}::uuid, ${after.ordinal}, ${after.id}::uuid)`
      : sql``;
    const rows: ScanRow[] = rowsOf<ScanRow>(
      await db.execute(sql`
        SELECT
          kc.id::text AS id,
          kc.knowledge_source_id::text AS knowledge_source_id,
          kc.ordinal AS ordinal,
          kc.embedding AS embedding
        FROM knowledge_chunks kc
        JOIN knowledge_sources ks ON ks.id = kc.knowledge_source_id
        WHERE kc.tenant_id = ${tenant_id}
          AND kc.embedding IS NOT NULL
          ${scopeFilter}
          ${keyset}
        ORDER BY kc.knowledge_source_id ASC, kc.ordinal ASC, kc.id ASC
        LIMIT ${opts.batch}
      `),
    );
    for (const row of rows) {
      if (!row.embedding || row.embedding.length === 0) continue;
      const score = cosineSimilarity(queryVector, row.embedding);
      if (score >= VECTOR_MIN_COSINE) keepTopScored(top, { item: row.id, score }, VECTOR_TOP);
    }
    scanned += rows.length;
    if (rows.length < opts.batch) break;
    after = rows[rows.length - 1] ?? null;
    if (scanned >= opts.ceiling) {
      logger.warn({
        module: "knowledge",
        action: "search.vector_scan_ceiling",
        msg: "vector scan stopped at its ceiling; later chunks were not compared",
        tenant_id,
        scanned,
        ceiling: opts.ceiling,
      });
      break;
    }
  }
  return top;
}

async function loadWinners(
  db: Executor,
  tenant_id: string,
  ids: readonly string[],
): Promise<Map<string, WinnerRow>> {
  if (ids.length === 0) return new Map();
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = rowsOf<WinnerRow>(
    await db.execute(sql`
      SELECT
        kc.id::text AS id,
        kc.knowledge_source_id::text AS knowledge_source_id,
        ks.name AS source_name,
        ks.tags AS source_tags,
        ks.description AS source_description,
        kc.title,
        kc.path,
        COALESCE(ks.last_refreshed_at, ks.updated_at) AS fetched_at,
        kc.content AS content
      FROM knowledge_chunks kc
      JOIN knowledge_sources ks ON ks.id = kc.knowledge_source_id
      WHERE kc.tenant_id = ${tenant_id}
        AND kc.id IN (${idList})
    `),
  );
  return new Map(rows.map((row) => [row.id, row]));
}

export async function fuseKnowledgeWithVectors(
  db: Executor,
  p: SearchKnowledgeParams,
  hits: KnowledgeSearchHit[],
  scopeFilter: SQL,
  limit: number,
  opts: { embedder?: QueryEmbedder; batch?: number; ceiling?: number } = {},
): Promise<KnowledgeSearchHit[]> {
  const queryVector = await embedQuery(p.query, opts.embedder);
  if (!queryVector) return hits;
  const top = await scanTopVectors(db, p.tenant_id, scopeFilter, queryVector, {
    batch: opts.batch ?? VECTOR_SCAN_BATCH,
    ceiling: opts.ceiling ?? KNOWLEDGE_VECTOR_SCAN_CEILING,
  });
  if (top.length === 0) return hits;
  const byId = new Map(hits.map((h) => [h.id, h]));
  const winners = await loadWinners(
    db,
    p.tenant_id,
    top.map((t) => t.item).filter((id) => !byId.has(id)),
  );
  const vector: KnowledgeSearchHit[] = [];
  for (const candidate of top) {
    const existing = byId.get(candidate.item);
    if (existing) {
      vector.push(existing);
      continue;
    }
    const row = winners.get(candidate.item);
    if (!row) continue;
    vector.push({
      id: row.id,
      knowledge_source_id: row.knowledge_source_id,
      source_name: row.source_name,
      source_tags: row.source_tags ?? [],
      source_description: row.source_description,
      title: row.title,
      path: row.path,
      snippet: bestPassage(row.content, p.query),
      rank: candidate.score,
      fetched_at:
        row.fetched_at instanceof Date
          ? row.fetched_at.toISOString()
          : typeof row.fetched_at === "string"
            ? row.fetched_at
            : null,
    });
  }
  return fuseByReciprocalRank({ lists: [hits, vector], idOf: (h) => h.id, limit });
}
