import { type SQL, sql } from "drizzle-orm";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
  executions,
  files,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../db/schema/index.ts";

function mentionsFile(document: SQL): SQL {
  const serialized = sql`lower(coalesce(${document}::text,''))`;
  return sql`(strpos(${serialized},${files.id}::text)>0 OR (
    ${files.slug} IS NOT NULL AND strpos(${serialized},'@attachment:' || lower(${files.slug}))>0
  ))`;
}

export function hasNoRetainedFileReference(): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${executions} e
    WHERE e.tenant_id=${files.tenant_id} AND e.status IN ('queued','running')
  ) AND NOT EXISTS (
    SELECT 1 FROM ${workflowVersions} v JOIN ${workflows} w
      ON w.id=v.workflow_id AND w.tenant_id=v.tenant_id
    WHERE v.tenant_id=${files.tenant_id} AND ${mentionsFile(sql`v.dag`)}
  ) AND NOT EXISTS (
    SELECT 1 FROM ${workflowsSchedules} s JOIN ${workflows} w
      ON w.id=s.workflow_id AND w.tenant_id=s.tenant_id
    WHERE s.tenant_id=${files.tenant_id} AND ${mentionsFile(sql`s.input`)}
  ) AND NOT EXISTS (
    SELECT 1 FROM ${conversations} c WHERE c.tenant_id=${files.tenant_id}
      AND (${mentionsFile(sql`c.draft`)} OR ${mentionsFile(sql`c.memory`)})
  ) AND NOT EXISTS (
    SELECT 1 FROM ${conversationMessages} m JOIN ${conversations} c
      ON c.id=m.conversation_id AND c.tenant_id=m.tenant_id
    WHERE m.tenant_id=${files.tenant_id} AND ${mentionsFile(sql`m.content`)}
  ) AND NOT EXISTS (
    SELECT 1 FROM ${conversationToolCalls} t JOIN ${conversations} c
      ON c.id=t.conversation_id AND c.tenant_id=t.tenant_id
    WHERE t.tenant_id=${files.tenant_id}
      AND (${mentionsFile(sql`t.input`)} OR ${mentionsFile(sql`t.output`)} OR ${mentionsFile(sql`t.confirmation_data`)})
  ) AND NOT EXISTS (
    SELECT 1 FROM ${conversationElicitations} q JOIN ${conversations} c
      ON c.id=q.conversation_id AND c.tenant_id=q.tenant_id
    WHERE q.tenant_id=${files.tenant_id}
      AND (${mentionsFile(sql`q.input`)} OR ${mentionsFile(sql`q.output`)})
  )`;
}
