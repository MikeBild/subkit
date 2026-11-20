import { sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";

export async function calledWorkflowHeldWrites(
  db: Executor,
  tenant_id: string,
  execution_id: string,
): Promise<boolean> {
  const rows = await db.execute<{ held: boolean }>(sql`
    WITH RECURSIVE called AS (
      SELECT child.id FROM executions child
       WHERE child.tenant_id = ${tenant_id} AND child.parent_execution_id = ${execution_id}
      UNION
      SELECT nested.id FROM executions nested
        JOIN called ON nested.parent_execution_id = called.id
       WHERE nested.tenant_id = ${tenant_id}
    )
    SELECT EXISTS (
      SELECT 1 FROM execution_steps step
        JOIN called ON step.execution_id = called.id
       WHERE step.tenant_id = ${tenant_id}
         AND (step.held OR step.request_meta #>> '{extras,held}' = 'true')
    ) AS held`);
  return rows.rows[0]?.held === true;
}
