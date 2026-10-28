import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
  executions,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../db/schema/index.ts";

export interface FileReferenceCandidate {
  id: string;
  tenant_id: string;
  slug: string | null;
}

const REFERENCE_SCAN_TIMEOUT_MS = 60_000;

function documents(tenants: SQL): SQL {
  const lowered = (document: SQL) => sql`lower(coalesce(${document}::text,''))`;
  return sql`
    SELECT v.tenant_id, ${lowered(sql`v.dag`)} AS doc FROM ${workflowVersions} v
      JOIN ${workflows} w ON w.id=v.workflow_id AND w.tenant_id=v.tenant_id
      WHERE v.tenant_id IN (${tenants})
    UNION ALL
    SELECT s.tenant_id, ${lowered(sql`s.input`)} FROM ${workflowsSchedules} s
      JOIN ${workflows} w ON w.id=s.workflow_id AND w.tenant_id=s.tenant_id
      WHERE s.tenant_id IN (${tenants})
    UNION ALL
    SELECT c.tenant_id, ${lowered(sql`c.draft`)} FROM ${conversations} c WHERE c.tenant_id IN (${tenants})
    UNION ALL
    SELECT c.tenant_id, ${lowered(sql`c.memory`)} FROM ${conversations} c WHERE c.tenant_id IN (${tenants})
    UNION ALL
    SELECT m.tenant_id, ${lowered(sql`m.content`)} FROM ${conversationMessages} m
      JOIN ${conversations} c ON c.id=m.conversation_id AND c.tenant_id=m.tenant_id
      WHERE m.tenant_id IN (${tenants})
    UNION ALL
    SELECT t.tenant_id, ${lowered(sql`t.input`)} || ' ' || ${lowered(sql`t.output`)} || ' ' || ${lowered(sql`t.confirmation_data`)}
      FROM ${conversationToolCalls} t
      JOIN ${conversations} c ON c.id=t.conversation_id AND c.tenant_id=t.tenant_id
      WHERE t.tenant_id IN (${tenants})
    UNION ALL
    SELECT q.tenant_id, ${lowered(sql`q.input`)} || ' ' || ${lowered(sql`q.output`)}
      FROM ${conversationElicitations} q
      JOIN ${conversations} c ON c.id=q.conversation_id AND c.tenant_id=q.tenant_id
      WHERE q.tenant_id IN (${tenants})`;
}

export async function findRetainedFileReferences(
  db: Db,
  candidates: readonly FileReferenceCandidate[],
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const values = sql.join(
    candidates.map(
      (candidate) =>
        sql`(${candidate.id}::uuid, ${candidate.tenant_id}::uuid, ${candidate.slug}::text)`,
    ),
    sql`,`,
  );
  const tenants = sql`SELECT DISTINCT tenant_id FROM candidate`;
  const rows = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout',${String(REFERENCE_SCAN_TIMEOUT_MS)},true)`,
    );
    const result = await tx.execute<{ id: string }>(sql`
      WITH candidate(id, tenant_id, slug) AS (VALUES ${values}),
      doc AS MATERIALIZED (${documents(tenants)})
      SELECT candidate.id::text AS id FROM candidate
      WHERE EXISTS (
        SELECT 1 FROM ${executions} e
        WHERE e.tenant_id=candidate.tenant_id AND e.status IN ('queued','running')
      ) OR EXISTS (
        SELECT 1 FROM doc
        WHERE doc.tenant_id=candidate.tenant_id AND (
          strpos(doc.doc, candidate.id::text)>0 OR (
            candidate.slug IS NOT NULL AND strpos(doc.doc,'@attachment:' || lower(candidate.slug))>0
          )
        )
      )`);
    return result.rows;
  });
  return new Set(rows.map((row) => row.id));
}
