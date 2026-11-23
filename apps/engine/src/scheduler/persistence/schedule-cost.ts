import { and, eq, type SQL, sql } from "drizzle-orm";
import { type Db, workflows } from "../../db/index.ts";
import { TERMINAL_EXECUTION_STATUSES } from "../../execution/index.ts";
import { llmCostCurrency, readLlmCost } from "../../stats/index.ts";
import { now } from "../../utils/index.ts";
import {
  projectScheduleCost,
  type RunCostSample,
  runsPerMonth,
  type ScheduleCostProjection,
} from "../cost-projection.ts";

export const COST_SAMPLE_RUNS = 20;

interface ScheduleRhythm {
  readonly workflow_id: string;
  readonly cron: string;
  readonly timezone: string;
  readonly input?: unknown;
}

function sampledRuns(tenantId: string, filter: SQL): SQL {
  const statuses = sql.join(
    TERMINAL_EXECUTION_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  return sql`(
    select executions.id
    from executions
    where executions.tenant_id = ${tenantId}
      and executions.source_kind = 'saved'
      and executions.status::text in (${statuses})
      and ${filter}
    order by executions.created_at desc, executions.id desc
    limit ${COST_SAMPLE_RUNS}
  ) as sampled_runs`;
}

async function sampleRunCost(db: Db, tenantId: string, filter: SQL): Promise<RunCostSample | null> {
  const counted = await db.execute(
    sql`select count(*)::int as runs from ${sampledRuns(tenantId, filter)}`,
  );
  const runs = Number((counted.rows[0] as { runs?: unknown } | undefined)?.runs ?? 0);
  if (runs === 0) return null;
  const cost = await readLlmCost(
    db,
    tenantId,
    sql`llm_usage.tenant_id = ${tenantId}`,
    sql`llm_usage join ${sampledRuns(tenantId, filter)} on sampled_runs.id = llm_usage.execution_id`,
  );
  return { runs, amount: cost.amount, unpriced_models: cost.unpriced_models };
}

async function currentVersionId(db: Db, tenantId: string, workflowId: string) {
  const rows = await db
    .select({ id: workflows.current_version_id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, tenantId), eq(workflows.id, workflowId)))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function scheduleCostProjection(
  db: Db,
  tenantId: string,
  rhythm: ScheduleRhythm,
): Promise<ScheduleCostProjection> {
  const versionId = await currentVersionId(db, tenantId, rhythm.workflow_id);
  const version = versionId
    ? await sampleRunCost(db, tenantId, sql`executions.workflow_version_id = ${versionId}`)
    : null;
  const workflow =
    version === null
      ? await sampleRunCost(
          db,
          tenantId,
          versionId
            ? sql`executions.workflow_id = ${rhythm.workflow_id} and executions.workflow_version_id is distinct from ${versionId}`
            : sql`executions.workflow_id = ${rhythm.workflow_id}`,
        )
      : null;
  return projectScheduleCost({
    runs_per_month: runsPerMonth(rhythm, new Date(now())),
    version,
    workflow,
    currency: llmCostCurrency(tenantId),
  });
}
