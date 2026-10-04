import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";

export function dagNamesFile(dag: unknown, fileId: unknown, slug: unknown): SQL {
  return sql`(${dag}::text LIKE '%' || ${fileId} || '%' OR (${slug}::text IS NOT NULL AND ${dag}::text ~ ('@attachment:' || ${slug}::text || '(?![a-z0-9_-])')))`;
}

export async function workflowUsageCounts(
  db: Db,
  tenant_id: string,
  pageFiles: ReadonlyArray<{ id: string; slug: string | null }>,
): Promise<Map<string, number>> {
  if (pageFiles.length === 0) return new Map();
  const ids = sql.join(
    pageFiles.map((f) => sql`${f.id}::uuid`),
    sql`, `,
  );
  const result = await db.execute<{ id: string; workflows: number }>(sql`
    with refs as (
      select distinct w.id as workflow_id, m[1] as ref
      from workflows w
      join workflow_versions v on v.id = w.current_version_id
      cross join lateral regexp_matches(
        v.dag::text, '(fid_[0-9a-f-]{36}|@attachment:[a-z0-9_-]+)', 'g'
      ) as m
      where w.tenant_id = ${tenant_id} and w.deleted_at is null
    )
    select f.id, count(distinct r.workflow_id)::int as workflows
    from files f
    join refs r
      on r.ref = 'fid_' || f.id::text
      or (f.slug is not null and r.ref = '@attachment:' || f.slug)
    where f.tenant_id = ${tenant_id} and f.id in (${ids})
    group by f.id
  `);
  return new Map(result.rows.map((row) => [row.id, Number(row.workflows)]));
}
