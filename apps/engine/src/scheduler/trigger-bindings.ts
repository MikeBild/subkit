import { z } from "@hono/zod-openapi";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { webhooksInbound, workflows, workflowsSchedules } from "../db/schema/index.ts";
import type { WorkflowTrigger } from "../workflows/types.ts";
import { scheduleNeedsActivation } from "./automation-status.ts";
import { nextScheduleFire } from "./next-fire.ts";

export const ScheduleBindingStateSchema = z.enum([
  "active",
  "paused",
  "held",
  "activation_required",
]);

export const WorkflowScheduleBindingSchema = z
  .object({
    id: z.string(),
    cron: z.string(),
    timezone: z.string(),
    paused: z.boolean(),
    execution_mode: z.enum(["dev", "prod"]),
    admission_hold: z
      .object({
        reason_code: z.enum([
          "execution_authority_required",
          "execution_authority_unavailable",
          "input_required",
        ]),
        observed_at: z.string(),
      })
      .nullable(),
    state: ScheduleBindingStateSchema,
    next_fire_at: z.string().nullable(),
    last_enqueued_at: z.string().nullable(),
  })
  .openapi("WorkflowScheduleBinding");

export const EffectiveTriggerSchema = z
  .object({
    kind: z.enum(["schedule", "webhook", "request"]),
    source: z.enum(["binding", "definition", "default"]),
    state: z.enum(["active", "paused", "held", "activation_required", "declared_unbound"]),
  })
  .openapi("EffectiveTrigger");

export type WorkflowScheduleBinding = z.infer<typeof WorkflowScheduleBindingSchema>;
export type EffectiveTrigger = z.infer<typeof EffectiveTriggerSchema>;

export interface TriggerBinding {
  schedule: WorkflowScheduleBinding | null;
  webhooks_active: number;
}

export interface WorkflowTriggerView extends TriggerBinding {
  effective_trigger: EffectiveTrigger;
}

const UNBOUND: TriggerBinding = { schedule: null, webhooks_active: 0 };

export async function loadTriggerBindings(
  tenantId: string,
  workflowIds: readonly string[],
  db: Executor,
  now: Date = new Date(),
): Promise<Map<string, TriggerBinding>> {
  const out = new Map<string, TriggerBinding>();
  const ids = [...new Set(workflowIds)];
  if (ids.length === 0) return out;
  const [schedules, webhooks] = await Promise.all([
    db
      .select({
        id: workflowsSchedules.id,
        workflow_id: workflowsSchedules.workflow_id,
        cron: workflowsSchedules.cron,
        timezone: workflowsSchedules.timezone,
        paused: workflowsSchedules.paused,
        execution_mode: workflowsSchedules.execution_mode,
        admission_hold: workflowsSchedules.admission_hold,
        input: workflowsSchedules.input,
        last_enqueued_at: workflowsSchedules.last_enqueued_at,
        created_at: workflowsSchedules.created_at,
        lifecycle: workflows.lifecycle,
        current_version_id: workflows.current_version_id,
      })
      .from(workflowsSchedules)
      .innerJoin(
        workflows,
        and(
          eq(workflows.id, workflowsSchedules.workflow_id),
          eq(workflows.tenant_id, workflowsSchedules.tenant_id),
        ),
      )
      .where(
        and(
          eq(workflowsSchedules.tenant_id, tenantId),
          inArray(workflowsSchedules.workflow_id, ids),
        ),
      ),
    db
      .select({
        workflow_id: webhooksInbound.workflow_id,
        active: sql<number>`count(*)::int`,
      })
      .from(webhooksInbound)
      .where(
        and(
          eq(webhooksInbound.tenant_id, tenantId),
          inArray(webhooksInbound.workflow_id, ids),
          eq(webhooksInbound.active, true),
        ),
      )
      .groupBy(webhooksInbound.workflow_id),
  ]);
  for (const s of schedules) {
    const state = scheduleBindingState(s);
    out.set(s.workflow_id, {
      webhooks_active: 0,
      schedule: {
        id: s.id,
        cron: s.cron,
        timezone: s.timezone,
        paused: s.paused,
        execution_mode: s.execution_mode,
        admission_hold: s.admission_hold ?? null,
        state,
        next_fire_at: state === "active" ? nextScheduleFire(s, now) : null,
        last_enqueued_at: s.last_enqueued_at?.toISOString() ?? null,
      },
    });
  }
  for (const w of webhooks) {
    const prior = out.get(w.workflow_id) ?? UNBOUND;
    out.set(w.workflow_id, { ...prior, webhooks_active: Number(w.active) });
  }
  return out;
}

export function scheduleBindingState(row: {
  paused: boolean;
  admission_hold: unknown;
  lifecycle: string;
  current_version_id: string | null;
}): WorkflowScheduleBinding["state"] {
  if (row.paused) return "paused";
  if (scheduleNeedsActivation(row)) return "activation_required";
  if (row.admission_hold) return "held";
  return "active";
}

export function bindingFor(
  bindings: ReadonlyMap<string, TriggerBinding>,
  workflowId: string,
): TriggerBinding {
  return bindings.get(workflowId) ?? UNBOUND;
}

export function resolveEffectiveTrigger(
  definitionTrigger: WorkflowTrigger | null | undefined,
  binding: TriggerBinding,
): EffectiveTrigger {
  const schedule = binding.schedule;
  if (schedule?.state === "active") return { kind: "schedule", source: "binding", state: "active" };
  if (binding.webhooks_active > 0) return { kind: "webhook", source: "binding", state: "active" };
  if (schedule) return { kind: "schedule", source: "binding", state: schedule.state };
  if (definitionTrigger?.kind === "schedule" || definitionTrigger?.kind === "webhook") {
    return { kind: definitionTrigger.kind, source: "definition", state: "declared_unbound" };
  }
  if (definitionTrigger?.kind === "request") {
    return { kind: "request", source: "definition", state: "active" };
  }
  return { kind: "request", source: "default", state: "active" };
}

export function workflowTriggerView(
  definitionTrigger: WorkflowTrigger | null | undefined,
  binding: TriggerBinding,
): WorkflowTriggerView {
  return {
    schedule: binding.schedule,
    webhooks_active: binding.webhooks_active,
    effective_trigger: resolveEffectiveTrigger(definitionTrigger, binding),
  };
}
