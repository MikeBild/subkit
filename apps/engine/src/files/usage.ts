// What it means for a workflow to use a file: its current version names the
// file, by id (`fid_<uuid>`) or by reference (`@attachment:<slug>`). One
// definition for the per-file usage endpoint and the counts on the list.

import { type SQL, sql } from "drizzle-orm";

/** True when `dag` (a workflow version's definition) names the file whose
 *  wire id is `fileId` or whose slug is `slug`. A slug match must end at a
 *  character the slug grammar cannot continue with, so `report` does not
 *  match `report-2`. */
export function dagNamesFile(dag: unknown, fileId: unknown, slug: unknown): SQL {
  return sql`(${dag}::text LIKE '%' || ${fileId} || '%' OR (${slug}::text IS NOT NULL AND ${dag}::text ~ ('@attachment:' || ${slug}::text || '(?![a-z0-9_-])')))`;
}
