import { AUTHORITY_REFUSAL_CODES } from "@shared/authority-refusal.ts";
import { and, count, desc, eq, gte, inArray } from "drizzle-orm";
import { AuditAction } from "../audit/types.ts";
import type { Executor } from "../db/client.ts";
import { withTenantScope } from "../db/index.ts";
import { auditLog, executions, webhooksInbound } from "../db/schema/index.ts";
import { inspectInboundHookAutomation, inspectScheduleAutomation } from "./automation-status.ts";
import { nextScheduleFire } from "./next-fire.ts";
import { listSchedules } from "./repo.ts";

export async function workflowAutomationView(
  tenant: string,
  workflow: string,
  db: Executor,
  now: Date,
) {
  const schedules = (await listSchedules(db, tenant, workflow)).rows;
  return Promise.all(
    schedules.map(async (schedule) => {
      const automation = await inspectScheduleAutomation(schedule, db);
      const fires = automation.state !== "paused" && automation.state !== "activation_required";
      return {
        ...automation,
        cron: schedule.cron,
        timezone: schedule.timezone,
        environment: schedule.execution_mode,
        next_run_at: fires ? nextScheduleFire(schedule, now) : null,
      };
    }),
  );
}

const REFUSED_DELIVERY_ACTIONS = [
  AuditAction.WEBHOOK_INBOUND_DENIED,
  AuditAction.WEBHOOK_TRIGGER_FAILED_VERIFICATION,
];

const REFUSAL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export async function inboundHookAutomationView(
  tenant: string,
  workflow: string,
  db: Executor,
  now: Date,
  options: { refusal_reasons: boolean },
) {
  const hooks = await withTenantScope(db, tenant, (tx) =>
    tx
      .select()
      .from(webhooksInbound)
      .where(and(eq(webhooksInbound.tenant_id, tenant), eq(webhooksInbound.workflow_id, workflow)))
      .orderBy(webhooksInbound.slug),
  );
  if (hooks.length === 0) return [];
  const refusals = await db
    .selectDistinctOn([auditLog.resource_id], {
      resource_id: auditLog.resource_id,
      ts: auditLog.ts,
      reason: auditLog.reason,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenant),
        inArray(auditLog.action, REFUSED_DELIVERY_ACTIONS),
        gte(auditLog.ts, new Date(now.getTime() - REFUSAL_LOOKBACK_MS)),
        eq(auditLog.resource_type, "webhook_inbound"),
        inArray(
          auditLog.resource_id,
          hooks.map((hook) => hook.id),
        ),
      ),
    )
    .orderBy(auditLog.resource_id, desc(auditLog.ts));
  const newest = new Map(refusals.map((row) => [row.resource_id, row]));
  return Promise.all(
    hooks.map(async (hook) => {
      const automation = await inspectInboundHookAutomation(hook, db);
      const refused = newest.get(hook.id);
      return {
        ...automation,
        slug: hook.slug,
        environment: "prod" as const,
        admission_hold: hook.active ? (hook.admission_hold ?? null) : null,
        last_refused_at: refused?.ts.toISOString() ?? null,
        last_refused_reason: options.refusal_reasons ? (refused?.reason ?? null) : null,
      };
    }),
  );
}

const DELIVERY_RATE_WINDOW_DAYS = 14;

const GATE_REFUSAL_REASONS = [...AUTHORITY_REFUSAL_CODES];

export async function inboundHookDeliveryRate(
  tenant: string,
  workflow: string,
  db: Executor,
  now: Date,
): Promise<{ deliveries: number; window_days: number } | null> {
  const hooks = await withTenantScope(db, tenant, (tx) =>
    tx
      .select({ id: webhooksInbound.id })
      .from(webhooksInbound)
      .where(
        and(
          eq(webhooksInbound.tenant_id, tenant),
          eq(webhooksInbound.workflow_id, workflow),
          eq(webhooksInbound.active, true),
        ),
      ),
  );
  if (hooks.length === 0) return null;
  const since = new Date(now.getTime() - DELIVERY_RATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [started] = await db
    .select({ n: count() })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, tenant),
        eq(executions.workflow_id, workflow),
        eq(executions.request_source, "webhook"),
        gte(executions.created_at, since),
      ),
    );
  const [refused] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenant),
        inArray(auditLog.action, REFUSED_DELIVERY_ACTIONS),
        gte(auditLog.ts, since),
        eq(auditLog.resource_type, "webhook_inbound"),
        inArray(
          auditLog.resource_id,
          hooks.map((hook) => hook.id),
        ),
        inArray(auditLog.reason, GATE_REFUSAL_REASONS),
      ),
    );
  return {
    deliveries: (started?.n ?? 0) + (refused?.n ?? 0),
    window_days: DELIVERY_RATE_WINDOW_DAYS,
  };
}
