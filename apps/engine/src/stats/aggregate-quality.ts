import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";

interface QualityStatsParams {
  tenantId: string;
  from: Date;
  to: Date;
  workflowId?: string | undefined;
}

interface QualityOneShot {
  succeeded: number;
  failed: number;
  total: number;
  success_rate: number;
}

interface QualityPostRepair {
  successes: number;
  failures: number;
  success_rate: number;
}

export interface QualityFailureReason {
  code: string;
  count: number;
}

interface QualityStatsResult {
  one_shot: QualityOneShot;
  post_repair: QualityPostRepair;
  failure_reasons: QualityFailureReason[];
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

export async function aggregateQuality(db: Db, p: QualityStatsParams): Promise<QualityStatsResult> {
  const execWhere: SQL[] = [
    sql`tenant_id = ${p.tenantId}`,
    sql`started_at is not null`,
    sql`started_at >= ${p.from}`,
    sql`started_at < ${p.to}`,
  ];
  if (p.workflowId) execWhere.push(sql`workflow_id = ${p.workflowId}`);
  const execWhereSql = sql.join(execWhere, sql` and `);

  const statusRows = (
    await db.execute(sql`
      select status::text as status, count(*)::int as n
      from executions
      where ${execWhereSql}
      group by status
    `)
  ).rows as Record<string, unknown>[];

  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[String(r.status)] = Number(r.n ?? 0);

  const succeeded = byStatus.succeeded ?? 0;
  const failed = byStatus.failed ?? 0;
  const timed_out = byStatus.timed_out ?? 0;
  const aborted = byStatus.aborted ?? 0;
  const oneShotDenom = succeeded + failed + timed_out + aborted;
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

  const reasonWhere: SQL[] = [
    sql`es.tenant_id = ${p.tenantId}`,
    sql`e.started_at is not null`,
    sql`e.started_at >= ${p.from}`,
    sql`e.started_at < ${p.to}`,
    sql`e.status in ('failed','timed_out')`,
    sql`es.status = 'failed'`,
  ];
  if (p.workflowId) reasonWhere.push(sql`e.workflow_id = ${p.workflowId}`);
  const reasonWhereSql = sql.join(reasonWhere, sql` and `);

  const reasonRows = (
    await db.execute(sql`
      select coalesce(es.error->>'code', 'unknown') as code, count(*)::int as n
      from execution_steps es
      join executions e
        on e.id = es.execution_id and e.tenant_id = es.tenant_id
      where ${reasonWhereSql}
      group by coalesce(es.error->>'code', 'unknown')
      order by n desc
    `)
  ).rows as Record<string, unknown>[];

  const failure_reasons: QualityFailureReason[] = reasonRows.map((r) => ({
    code: String(r.code),
    count: Number(r.n ?? 0),
  }));

  const repairWhere: SQL[] = [
    sql`tenant_id = ${p.tenantId}`,
    sql`status = 'applied'`,
    sql`outcome_window_ended_at is not null`,
    sql`outcome_window_ended_at >= ${p.from}`,
    sql`outcome_window_ended_at < ${p.to}`,
  ];
  if (p.workflowId) repairWhere.push(sql`workflow_id = ${p.workflowId}`);
  const repairWhereSql = sql.join(repairWhere, sql` and `);

  const repairRow = ((
    await db.execute(sql`
      select
        coalesce(sum(outcome_successes_after), 0)::int as successes,
        coalesce(sum(outcome_failures_after), 0)::int as failures
      from patch_candidates
      where ${repairWhereSql}
    `)
  ).rows[0] ?? {}) as Record<string, unknown>;

  const successes = Number(repairRow.successes ?? 0);
  const failures = Number(repairRow.failures ?? 0);

  return {
    one_shot: {
      succeeded,
      failed,
      total,
      success_rate: rate(succeeded, oneShotDenom),
    },
    post_repair: {
      successes,
      failures,
      success_rate: rate(successes, successes + failures),
    },
    failure_reasons,
  };
}
