import { type SQL, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { DOMAIN_TAG_PREFIX } from "./tags.ts";
import type { KnowledgeSearchHit } from "./types.ts";

type KnowledgeFtsRow = {
  id: string;
  knowledge_source_id: string;
  source_name: string;
  source_tags: string[] | null;
  source_description: string | null;
  title: string | null;
  path: string | null;
  snippet: string;
  rank: number | string;
  fetched_at: Date | string | null;
};

export async function domainTaggedSourceIds(
  db: Executor,
  tenant_id: string,
  tsquery: SQL,
): Promise<string[]> {
  const out = await db.execute(sql`
    SELECT ks.id::text AS id
    FROM knowledge_sources ks
    WHERE ks.tenant_id = ${tenant_id}
      AND EXISTS (
        SELECT 1 FROM unnest(ks.tags) AS tag
        WHERE lower(tag) LIKE ${`${DOMAIN_TAG_PREFIX}%`}
          AND to_tsvector('english', regexp_replace(substr(tag, ${DOMAIN_TAG_PREFIX.length + 1}), '[-_/.]+', ' ', 'g')) @@ ${tsquery}
      )
      AND ks.deleted_at IS NULL
      AND ks.status = 'active'
  `);
  return (out.rows as Array<{ id: string }>).map((r) => r.id);
}

export async function runKnowledgeFts(
  db: Executor,
  tenant_id: string,
  tsquery: SQL,
  scopeFilter: SQL,
  limit: number,
  domainSourceIds: readonly string[],
): Promise<KnowledgeSearchHit[]> {
  const domainIds =
    domainSourceIds.length > 0
      ? sql`ARRAY[${sql.join(
          domainSourceIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[]`
      : null;
  const match = domainIds
    ? sql`(kc.tsv @@ ${tsquery} OR kc.knowledge_source_id = ANY(${domainIds}))`
    : sql`kc.tsv @@ ${tsquery}`;
  const rank = domainIds
    ? sql`ts_rank_cd(kc.tsv, ${tsquery}) + CASE WHEN kc.knowledge_source_id = ANY(${domainIds}) THEN 0.1 ELSE 0 END`
    : sql`ts_rank_cd(kc.tsv, ${tsquery})`;
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
      ts_headline(
        'english',
        kc.content,
        ${tsquery},
        'MaxWords=25, MinWords=5'
      ) AS snippet,
      ${rank} AS rank
    FROM knowledge_chunks kc
    JOIN knowledge_sources ks ON ks.id = kc.knowledge_source_id
    WHERE kc.tenant_id = ${tenant_id}
      AND ${match}
      ${scopeFilter}
    ORDER BY rank DESC, ks.slug ASC, kc.path ASC, kc.ordinal ASC, kc.id ASC
    LIMIT ${limit}
  `);

  return (out.rows as KnowledgeFtsRow[]).map((r) => ({
    id: r.id,
    knowledge_source_id: r.knowledge_source_id,
    source_name: r.source_name,
    source_tags: r.source_tags ?? [],
    source_description: r.source_description,
    title: r.title,
    path: r.path,
    snippet: r.snippet,
    rank: typeof r.rank === "string" ? parseFloat(r.rank) : r.rank,
    fetched_at:
      r.fetched_at instanceof Date
        ? r.fetched_at.toISOString()
        : typeof r.fetched_at === "string"
          ? r.fetched_at
          : null,
  }));
}
