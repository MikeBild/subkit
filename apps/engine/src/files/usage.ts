// What it means for a workflow to use a file: its current version names the
// file, by id (`fid_<uuid>`) or by reference (`@attachment:<slug>`). One
// definition for the per-file usage endpoint and the counts on the list.

import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";

/** True when `dag` (a workflow version's definition) names the file whose
 *  wire id is `fileId` or whose slug is `slug`. A slug match must end at a
 *  character the slug grammar cannot continue with, so `report` does not
 *  match `report-2`. */
export function dagNamesFile(dag: unknown, fileId: unknown, slug: unknown): SQL {
  return sql`(${dag}::text LIKE '%' || ${fileId} || '%' OR (${slug}::text IS NOT NULL AND ${dag}::text ~ ('@attachment:' || ${slug}::text || '(?![a-z0-9_-])')))`;
}

/**
 * How many workflows use each of `pageFiles`, by the rule `dagNamesFile`
 * states — for a whole list page at once. Every current definition is read
 * once and its references extracted, instead of searching every definition
 * once per file: a list page of fifty files over a large catalog took
 * seconds the other way.
 */
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
  // A slug token runs as long as the grammar continues, so an extracted
  // `@attachment:report-2` never equals `@attachment:report`.
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
