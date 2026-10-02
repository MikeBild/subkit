// What the attention list knows about approvals BEFORE a start is refused.
//
// A held schedule or hook is an observed refusal (`admission_hold`). It is
// recorded on the first start the gate turns away — which, for a version saved
// on Monday and a schedule that fires on Friday, is four days after anyone
// could have acted. This reader derives the two earlier facts from what is
// already stored, and writes nothing:
//
//   * awaiting — something starts the workflow automatically and no approval
//     covers the running version there. The next start will be refused.
//   * expiring — every approval that still covers it is close to its end.
//
// "Covers" is admission's own predicate minus the effect-manifest digest, which
// only the gate can compute: an approval whose boundary has drifted is found by
// the first refused start, as before, and becomes a hold on the same workflow.
//
// Saved drafts are not read here on purpose. A draft starts nothing until a
// person applies it; that is the workflow page's "change waiting" state, not a
// task on this list.

import { and, eq, gt, isNull, lte, type SQL, sql } from "drizzle-orm";
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
  AUTHORITY_EXTEND_BELOW_RUN_SHARE,
  AUTHORITY_EXTEND_WITHIN_DAYS,
} from "../workflows/authority-extension.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ApprovalFact {
  workflow_id: string;
  name: string;
  kind: "awaiting" | "expiring";
  /** The running version's number. */
  version: number;
  environment: "dev" | "prod";
  trigger: { kind: "schedule" | "inbound_hook"; name: string | null };
  /** Awaiting: since the version was saved. Expiring: null — it has no start. */
  since: string | null;
  /** Awaiting: the next scheduled start. Expiring: the end of the last
   *  approval, when a date is what ends it. */
  deadline: string | null;
}

/** The approvals admission would use for this workflow's running version. */
function covering(now: Date, environment: SQL): SQL | undefined {
  return and(
    eq(workflowExecutionAuthorities.tenant_id, workflows.tenant_id),
    eq(workflowExecutionAuthorities.workflow_id, workflows.id),
    eq(workflowExecutionAuthorities.workflow_version_id, workflows.current_version_id),
    sql`${workflowExecutionAuthorities.execution_environment} = ${environment}`,
    isNull(workflowExecutionAuthorities.revoked_at),
    lte(workflowExecutionAuthorities.valid_from, now),
    gt(workflowExecutionAuthorities.valid_until, now),
    sql`${workflowExecutionAuthorities.reserved_runs} < ${workflowExecutionAuthorities.max_runs}`,
  );
}

/** The three answers one trigger needs, each a subquery over its approvals. */
function approvalColumns(db: Db, now: Date, environment: SQL) {
  const soon = new Date(now.getTime() + AUTHORITY_EXTEND_WITHIN_DAYS * DAY_MS);
  return {
    covered: sql<boolean>`EXISTS ${db
      .select({ one: sql`1` })
      .from(workflowExecutionAuthorities)
      .where(covering(now, environment))}`,
    // An approval with room: it ends later than the threshold and has runs to spare.
    comfortable: sql<boolean>`EXISTS ${db
      .select({ one: sql`1` })
      .from(workflowExecutionAuthorities)
      .where(
        and(
          covering(now, environment),
          gt(workflowExecutionAuthorities.valid_until, soon),
          sql`(${workflowExecutionAuthorities.max_runs} - ${workflowExecutionAuthorities.reserved_runs})::float8 / ${workflowExecutionAuthorities.max_runs} >= ${AUTHORITY_EXTEND_BELOW_RUN_SHARE}`,
        ),
      )}`,
    // When the last covering approval ends.
    ends: sql<Date | string | null>`(${db
      .select({ until: sql`max(${workflowExecutionAuthorities.valid_until})` })
      .from(workflowExecutionAuthorities)
      .where(covering(now, environment))})`,
  };
}

/** A workflow that can run on its own: active, with a running version. */
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
  if (!row.covered)
    return {
      ...base,
      kind: "awaiting",
      since: row.saved_at.toISOString(),
      deadline: row.next_run_at,
    };
  if (row.comfortable) return null;
  const ends = row.ends === null ? null : new Date(row.ends);
  // A date is the deadline only when the date is what ends it; an approval
  // running out of runs ends when the next few starts have used them.
  const byDate =
    ends !== null && ends.getTime() - now.getTime() <= AUTHORITY_EXTEND_WITHIN_DAYS * DAY_MS;
  return {
    ...base,
    kind: "expiring",
    since: null,
    deadline: byDate && ends ? ends.toISOString() : null,
  };
}

/**
 * Per workflow, the approval fact of its unheld automatic starts: awaiting
 * before expiring, and within a kind the nearest deadline. Held triggers are
 * left to the hold itself — it is the stronger statement about the same thing.
 */
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
        slug: webhooksInbound.slug,
        // Unattended deliveries only ever run in production.
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
