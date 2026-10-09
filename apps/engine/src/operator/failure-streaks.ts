import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { executions } from "../db/schema/index.ts";

export async function readFailureStreaks(
  db: Db,
  tenantId: string,
  workflowIds: string[],
  generatedAt: Date,
): Promise<Map<string, number>> {
  if (workflowIds.length === 0) return new Map();
  const rows = await db.execute<{ workflow_id: string; failures: number }>(sql`
    with terminal_runs as (
      select workflow_id, status,
        sum(case when status = 'failed' then 0 else 1 end) over (
          partition by workflow_id
          order by coalesce(finished_at, created_at) desc, id desc
          rows between unbounded preceding and current row
        ) as interruptions
      from ${executions}
      where tenant_id = ${tenantId}
        and workflow_id in (${sql.join(
          workflowIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        and status in ('failed', 'succeeded', 'aborted', 'timed_out')
        and coalesce(finished_at, created_at) <= ${generatedAt.toISOString()}::timestamptz
    )
    select workflow_id, count(*)::int as failures
    from terminal_runs
    where status = 'failed' and interruptions = 0
    group by workflow_id
  `);
  return new Map(rows.rows.map((row) => [row.workflow_id, row.failures]));
}
