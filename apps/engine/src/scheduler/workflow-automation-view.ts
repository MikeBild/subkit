import { and, desc, eq, inArray } from "drizzle-orm";
import { AuditAction } from "../audit/types.ts";
import type { Executor } from "../db/client.ts";
import { auditLog, webhooksInbound } from "../db/schema/index.ts";
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

/** Both spellings of a refused delivery: `crud` hooks and trigger-bound ones. */
const REFUSED_DELIVERY_ACTIONS = [
  AuditAction.WEBHOOK_INBOUND_DENIED,
  AuditAction.WEBHOOK_TRIGGER_FAILED_VERIFICATION,
];

/**
 * The workflow's inbound hooks, judged like its schedules. A hook is the other
 * thing that starts runs without a person, and one the authority gate refuses
 * on every delivery used to leave no trace here at all.
 */
export async function inboundHookAutomationView(tenant: string, workflow: string, db: Executor) {
  const hooks = await db
    .select()
    .from(webhooksInbound)
    .where(and(eq(webhooksInbound.tenant_id, tenant), eq(webhooksInbound.workflow_id, workflow)))
    .orderBy(webhooksInbound.slug);
  return Promise.all(
    hooks.map(async (hook) => {
      const automation = await inspectInboundHookAutomation(hook, db);
      // The newest refusal, whatever gate refused it — (tenant, action, ts) is indexed.
      const [refused] = await db
        .select({ ts: auditLog.ts, reason: auditLog.reason })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, tenant),
            inArray(auditLog.action, REFUSED_DELIVERY_ACTIONS),
            eq(auditLog.resource_type, "webhook_inbound"),
            eq(auditLog.resource_id, hook.id),
          ),
        )
        .orderBy(desc(auditLog.ts))
        .limit(1);
      return {
        ...automation,
        slug: hook.slug,
        environment: "prod" as const,
        admission_hold: hook.admission_hold ?? null,
        last_refused_at: refused?.ts.toISOString() ?? null,
        last_refused_reason: refused?.reason ?? null,
      };
    }),
  );
}
