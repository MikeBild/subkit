import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client.ts";
import { taskGrants, workflowExecutionAuthorities } from "../../db/schema/index.ts";
import { errorFields, logger } from "../../logging/index.ts";
import { invalidateTenantState } from "../../operator/index.ts";
import { emitScheduleEvent } from "../../webhooks/events/schedule-events.ts";
import { AUTHORITY_EXPIRY_NOTIFY_DAYS } from "../authority-extension.ts";

export const APPROVAL_EXPIRY_NOTICE_BATCH = 200;

const DAY_MS = 86_400_000;
const Instant = z.union([z.date(), z.string()]).transform((value) => new Date(value));
const Environment = z.enum(["dev", "prod"]);

const AuthorityRow = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  workflow_id: z.string().uuid(),
  workflow_name: z.string().nullable(),
  environment: Environment,
  valid_until: Instant,
});

const GrantRow = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  task_id: z.string().uuid(),
  task_name: z.string().nullable(),
  environment: Environment,
  valid_until: Instant,
});

export function workflowRenewHref(workflow_id: string): string {
  return `/cockpit/workflows/${encodeURIComponent(workflow_id)}#workflow-automation`;
}

export function taskRenewHref(task_id: string): string {
  return `/cockpit/tasks/${encodeURIComponent(task_id)}`;
}

async function notifyWorkflowAuthorities(db: Db, now: Date, horizon: Date): Promise<number> {
  // tenant-filter:exempt — bounded sweep over every live tenant; each row carries its tenant_id into a tenant-keyed claim.
  const due = await db.execute(sql`
    SELECT a.id, a.tenant_id, a.workflow_id, w.name AS workflow_name,
           a.execution_environment AS environment, a.valid_until
    FROM subkit.workflow_execution_authorities a
    JOIN subkit.workflows w
      ON w.tenant_id = a.tenant_id AND w.id = a.workflow_id
     AND w.current_version_id = a.workflow_version_id
     AND w.deleted_at IS NULL AND w.lifecycle = 'active'
    JOIN subkit.tenants t ON t.id = a.tenant_id AND t.status = 'active' AND t.deleted_at IS NULL
    WHERE a.revoked_at IS NULL AND a.expiry_notified_at IS NULL
      AND a.valid_from <= ${now.toISOString()}::timestamptz
      AND a.valid_until > ${now.toISOString()}::timestamptz
      AND a.valid_until <= ${horizon.toISOString()}::timestamptz
      AND (a.max_runs IS NULL OR a.reserved_runs < a.max_runs)
      AND (
        EXISTS (
          SELECT 1 FROM subkit.workflows_schedules s
          WHERE s.tenant_id = a.tenant_id AND s.workflow_id = a.workflow_id
            AND s.execution_mode = a.execution_environment AND NOT s.paused
        )
        OR (
          a.execution_environment = 'prod' AND EXISTS (
            SELECT 1 FROM subkit.webhooks_inbound h
            WHERE h.tenant_id = a.tenant_id AND h.workflow_id = a.workflow_id AND h.active
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM subkit.workflow_execution_authorities longer
        WHERE longer.tenant_id = a.tenant_id AND longer.workflow_id = a.workflow_id
          AND longer.workflow_version_id = a.workflow_version_id
          AND longer.execution_environment = a.execution_environment
          AND longer.id <> a.id AND longer.revoked_at IS NULL
          AND longer.valid_from <= ${now.toISOString()}::timestamptz
          AND (longer.valid_until IS NULL OR longer.valid_until > a.valid_until)
          AND (longer.max_runs IS NULL OR longer.reserved_runs < longer.max_runs)
      )
    ORDER BY a.valid_until, a.id
    LIMIT ${APPROVAL_EXPIRY_NOTICE_BATCH}
  `);
  let notified = 0;
  for (const row of z.array(AuthorityRow).parse(due.rows)) {
    const claimed = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(workflowExecutionAuthorities)
        .set({ expiry_notified_at: now })
        .where(
          and(
            eq(workflowExecutionAuthorities.tenant_id, row.tenant_id),
            eq(workflowExecutionAuthorities.id, row.id),
            isNull(workflowExecutionAuthorities.expiry_notified_at),
            isNull(workflowExecutionAuthorities.revoked_at),
          ),
        )
        .returning({ id: workflowExecutionAuthorities.id });
      if (!updated) return false;
      await emitScheduleEvent(tx, row.tenant_id, "workflow.approval_expiring", {
        severity: "warn",
        workflow_id: row.workflow_id,
        workflow_name: row.workflow_name,
        authority_id: row.id,
        environment: row.environment,
        valid_until: row.valid_until.toISOString(),
        remedy: { kind: "renew", href: workflowRenewHref(row.workflow_id) },
      });
      return true;
    });
    if (!claimed) continue;
    notified++;
    invalidateTenantState(row.tenant_id);
  }
  return notified;
}

async function notifyTaskGrants(db: Db, now: Date, horizon: Date): Promise<number> {
  // tenant-filter:exempt — bounded sweep over every live tenant; each row carries its tenant_id into a tenant-keyed claim.
  const due = await db.execute(sql`
    SELECT g.id, g.tenant_id, g.task_id, k.name AS task_name, g.environment, g.valid_until
    FROM subkit.task_grants g
    JOIN subkit.tasks k
      ON k.tenant_id = g.tenant_id AND k.id = g.task_id
     AND k.lifecycle = 'active' AND k.paused_at IS NULL
     AND k.fingerprint = g.fingerprint AND k.environment = g.environment
     AND (k.schedule_cron IS NOT NULL OR (k.schedule_run_at IS NOT NULL AND k.last_claimed_at IS NULL))
    JOIN subkit.tenants t ON t.id = g.tenant_id AND t.status = 'active' AND t.deleted_at IS NULL
    WHERE g.revoked_at IS NULL AND g.expiry_notified_at IS NULL
      AND g.valid_from <= ${now.toISOString()}::timestamptz
      AND g.valid_until > ${now.toISOString()}::timestamptz
      AND g.valid_until <= ${horizon.toISOString()}::timestamptz
      AND (g.max_runs IS NULL OR g.reserved_runs < g.max_runs)
    ORDER BY g.valid_until, g.id
    LIMIT ${APPROVAL_EXPIRY_NOTICE_BATCH}
  `);
  let notified = 0;
  for (const row of z.array(GrantRow).parse(due.rows)) {
    const claimed = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(taskGrants)
        .set({ expiry_notified_at: now })
        .where(
          and(
            eq(taskGrants.tenant_id, row.tenant_id),
            eq(taskGrants.id, row.id),
            isNull(taskGrants.expiry_notified_at),
            isNull(taskGrants.revoked_at),
          ),
        )
        .returning({ id: taskGrants.id });
      if (!updated) return false;
      await emitScheduleEvent(tx, row.tenant_id, "task.grant_expiring", {
        severity: "warn",
        task_id: row.task_id,
        task_name: row.task_name,
        grant_id: row.id,
        environment: row.environment,
        valid_until: row.valid_until.toISOString(),
        remedy: { kind: "renew", href: taskRenewHref(row.task_id) },
      });
      return true;
    });
    if (!claimed) continue;
    notified++;
    invalidateTenantState(row.tenant_id);
  }
  return notified;
}

export async function runApprovalExpiryNotices(now: Date, db: Db): Promise<void> {
  const horizon = new Date(now.getTime() + AUTHORITY_EXPIRY_NOTIFY_DAYS * DAY_MS);
  try {
    const workflow_authorities = await notifyWorkflowAuthorities(db, now, horizon);
    const task_grants = await notifyTaskGrants(db, now, horizon);
    if (workflow_authorities + task_grants > 0)
      logger.info({
        module: "scheduler",
        action: "approval_expiry_notice.completed",
        msg: "approvals that end soon were announced",
        workflow_authorities,
        task_grants,
      });
  } catch (error) {
    logger.warn({
      module: "scheduler",
      action: "approval_expiry_notice.sweep_failed",
      msg: "announcing approvals that end soon failed; the next pass tries again",
      ...errorFields(error),
    });
  }
}
