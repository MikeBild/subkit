import { z } from "@hono/zod-openapi";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  webhooksInbound,
  workflowExecutionAuthorities,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../db/schema/index.ts";
import { nextScheduleFire } from "../scheduler/next-fire.ts";
import {
  AUTHORITY_EXPIRY_ATTENTION_DAYS,
  AUTHORITY_EXTEND_BELOW_RUN_SHARE,
} from "../workflows/authority-extension.ts";
import { type BoundaryGrowth, BoundaryGrowthSchema } from "../workflows/authority-growth.ts";
import { authorityLive, authorityNotExpired } from "../workflows/authority-live.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ApprovalFact {
  workflow_id: string;
  name: string;
  kind: "awaiting" | "expiring";
  version: number;
  environment: "dev" | "prod";
  trigger: { kind: "schedule" | "inbound_hook"; name: string | null };
  since: string | null;
  deadline: string | null;
  growth?: BoundaryGrowth[];
}

function covering(now: Date, environment: SQL): SQL | undefined {
  return and(
    eq(workflowExecutionAuthorities.tenant_id, workflows.tenant_id),
    eq(workflowExecutionAuthorities.workflow_id, workflows.id),
    eq(workflowExecutionAuthorities.workflow_version_id, workflows.current_version_id),
    sql`${workflowExecutionAuthorities.execution_environment} = ${environment}`,
    authorityLive(now),
  );
}

function approvalColumns(db: Db, now: Date, environment: SQL) {
  const soon = new Date(now.getTime() + AUTHORITY_EXPIRY_ATTENTION_DAYS * DAY_MS);
  return {
    covered: sql<boolean>`EXISTS ${db
      .select({ one: sql`1` })
      .from(workflowExecutionAuthorities)
      .where(covering(now, environment))}`,
    comfortable: sql<boolean>`EXISTS ${db
      .select({ one: sql`1` })
      .from(workflowExecutionAuthorities)
      .where(
        and(
          covering(now, environment),
          authorityNotExpired(soon),
          sql`(${workflowExecutionAuthorities.max_runs} IS NULL OR (${workflowExecutionAuthorities.max_runs} - ${workflowExecutionAuthorities.reserved_runs})::float8 / ${workflowExecutionAuthorities.max_runs} >= ${AUTHORITY_EXTEND_BELOW_RUN_SHARE})`,
        ),
      )}`,
    ends: sql<Date | string | null>`(${db
      .select({
        until: sql`CASE WHEN bool_or(${workflowExecutionAuthorities.valid_until} IS NULL) THEN NULL ELSE max(${workflowExecutionAuthorities.valid_until}) END`,
      })
      .from(workflowExecutionAuthorities)
      .where(covering(now, environment))})`,
  };
}

function runnable(): SQL | undefined {
  return and(
    isNull(workflows.deleted_at),
    eq(workflows.lifecycle, "active"),
    sql`${workflows.current_version_id} IS NOT NULL`,
  );
}

interface TriggerRow {
  workflow_id: string;
  name: string;
  version: number;
  saved_at: Date;
  authority_growth: Record<string, unknown> | null;
  environment: "dev" | "prod";
  covered: boolean;
  comfortable: boolean;
  ends: Date | string | null;
  trigger: ApprovalFact["trigger"];
  next_run_at: string | null;
}

function factOf(row: TriggerRow, now: Date): ApprovalFact | null {
  const base = {
    workflow_id: row.workflow_id,
    name: row.name,
    version: row.version,
    environment: row.environment,
    trigger: row.trigger,
  };
  if (!row.covered) {
    const growth = z.array(BoundaryGrowthSchema).safeParse(row.authority_growth?.[row.environment]);
    return {
      ...base,
      kind: "awaiting",
      since: row.saved_at.toISOString(),
      deadline: row.next_run_at,
      ...(growth.success && growth.data.length > 0 ? { growth: growth.data } : {}),
    };
  }
  if (row.comfortable) return null;
  const ends = row.ends === null ? null : new Date(row.ends);
  const byDate =
    ends !== null && ends.getTime() - now.getTime() <= AUTHORITY_EXPIRY_ATTENTION_DAYS * DAY_MS;
  return {
    ...base,
    kind: "expiring",
    since: null,
    deadline: byDate && ends ? ends.toISOString() : null,
  };
}

export async function readApprovalFacts(
  db: Db,
  tenantId: string,
  now: Date,
): Promise<Map<string, ApprovalFact>> {
  const [schedules, hooks] = await Promise.all([
    db
      .select({
        workflow_id: workflows.id,
        name: workflows.name,
        version: workflowVersions.version,
        saved_at: workflowVersions.created_at,
        authority_growth: workflowVersions.authority_growth,
        environment: workflowsSchedules.execution_mode,
        cron: workflowsSchedules.cron,
        timezone: workflowsSchedules.timezone,
        input: workflowsSchedules.input,
        last_enqueued_at: workflowsSchedules.last_enqueued_at,
        created_at: workflowsSchedules.created_at,
        ...approvalColumns(db, now, sql`${workflowsSchedules.execution_mode}`),
      })
      .from(workflowsSchedules)
      .innerJoin(
        workflows,
        and(
          eq(workflows.id, workflowsSchedules.workflow_id),
          eq(workflows.tenant_id, workflowsSchedules.tenant_id),
        ),
      )
      .innerJoin(
        workflowVersions,
        and(
          eq(workflowVersions.id, workflows.current_version_id),
          eq(workflowVersions.tenant_id, workflows.tenant_id),
        ),
      )
      .where(
        and(
          eq(workflowsSchedules.tenant_id, tenantId),
          eq(workflowsSchedules.paused, false),
          isNull(workflowsSchedules.admission_hold),
          runnable(),
        ),
      ),
    db
      .select({
        workflow_id: workflows.id,
        name: workflows.name,
        version: workflowVersions.version,
        saved_at: workflowVersions.created_at,
        authority_growth: workflowVersions.authority_growth,
        slug: webhooksInbound.slug,
        ...approvalColumns(db, now, sql`'prod'`),
      })
      .from(webhooksInbound)
      .innerJoin(
        workflows,
        and(
          eq(workflows.id, webhooksInbound.workflow_id),
          eq(workflows.tenant_id, webhooksInbound.tenant_id),
        ),
      )
      .innerJoin(
        workflowVersions,
        and(
          eq(workflowVersions.id, workflows.current_version_id),
          eq(workflowVersions.tenant_id, workflows.tenant_id),
        ),
      )
      .where(
        and(
          eq(webhooksInbound.tenant_id, tenantId),
          eq(webhooksInbound.active, true),
          isNull(webhooksInbound.admission_hold),
          runnable(),
        ),
      ),
  ]);

  const rows: TriggerRow[] = [
    ...schedules.map((row) => ({
      ...row,
      trigger: { kind: "schedule" as const, name: null },
      next_run_at: nextScheduleFire(row, now),
    })),
    ...hooks.map((row) => ({
      ...row,
      environment: "prod" as const,
      trigger: { kind: "inbound_hook" as const, name: row.slug },
      next_run_at: null,
    })),
  ];

  const facts = new Map<string, ApprovalFact>();
  const sooner = (a: string | null, b: string | null) => a !== null && (b === null || a < b);
  for (const row of rows) {
    const fact = factOf(row, now);
    if (!fact) continue;
    const prior = facts.get(fact.workflow_id);
    if (
      !prior ||
      (fact.kind === "awaiting" && prior.kind === "expiring") ||
      (fact.kind === prior.kind && sooner(fact.deadline, prior.deadline))
    )
      facts.set(fact.workflow_id, fact);
  }
  return facts;
}
