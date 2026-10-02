import { and, count, desc, eq, gte, inArray } from "drizzle-orm";
import { AuditAction } from "../audit/types.ts";
import type { Executor } from "../db/client.ts";
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

/** Both spellings of a refused delivery: `crud` hooks and trigger-bound ones. */
const REFUSED_DELIVERY_ACTIONS = [
  AuditAction.WEBHOOK_INBOUND_DENIED,
  AuditAction.WEBHOOK_TRIGGER_FAILED_VERIFICATION,
];

/** How far back the newest refused delivery is looked for. The standing state
 *  is `admission_hold`; this only dates it, and bounds the audit scan. */
const REFUSAL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The workflow's inbound hooks, judged like its schedules. A hook is the other
 * thing that starts runs without a person, and one the authority gate refuses
 * on every delivery used to leave no trace here at all.
 *
 * A deactivated hook receives nothing, so it holds nothing: its hold reads as
 * null here exactly as a paused schedule's does, and the overview and the
 * attention list count only active hooks. `refusal_reasons` is the caller's
 * audit visibility — the reason text is audit-log content.
 */
export async function inboundHookAutomationView(
  tenant: string,
  workflow: string,
  db: Executor,
  now: Date,
  options: { refusal_reasons: boolean },
) {
  const hooks = await db
    .select()
    .from(webhooksInbound)
    .where(and(eq(webhooksInbound.tenant_id, tenant), eq(webhooksInbound.workflow_id, workflow)))
    .orderBy(webhooksInbound.slug);
  if (hooks.length === 0) return [];
  // The newest refusal per hook, whatever gate refused it — one scan of the
  // (tenant, action, ts) index, bounded by the lookback window.
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

/** How far back a hook's deliveries are counted for a suggested run limit. */
const DELIVERY_RATE_WINDOW_DAYS = 14;

/** The refusals of the approval gate itself — a delivery that was authentic
 *  and would have started a run under an approval. */
const GATE_REFUSAL_REASONS = ["execution_authority_required", "execution_authority_unavailable"];

/**
 * How often the workflow's active inbound hooks were really called lately: the
 * runs they started plus the deliveries the approval gate refused. Both are
 * calls an approval has to cover — counting started runs alone would size the
 * approval of a hook nobody has approved yet from zero.
 *
 * Null when no hook is active: nothing delivers, so there is no rate.
 * Read-only; the count only sizes a suggestion a person still confirms.
 */
export async function inboundHookDeliveryRate(
  tenant: string,
  workflow: string,
  db: Executor,
  now: Date,
): Promise<{ deliveries: number; window_days: number } | null> {
  const hooks = await db
    .select({ id: webhooksInbound.id })
    .from(webhooksInbound)
    .where(
      and(
        eq(webhooksInbound.tenant_id, tenant),
        eq(webhooksInbound.workflow_id, workflow),
        eq(webhooksInbound.active, true),
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
