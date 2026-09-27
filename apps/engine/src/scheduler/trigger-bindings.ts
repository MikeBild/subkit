// What actually starts a workflow — as opposed to what its definition says.
//
// A workflow's definition carries an optional `trigger`, but the scheduler does
// not fire from the definition: it fires from the `workflows_schedules` row. A
// schedule created through `POST /v1/schedules` exists ONLY as that row, so a
// catalog that read the definition alone reported such a workflow as "runs on
// request" while it fired every hour. Inbound webhooks are the same shape: the
// `webhooks_inbound` row is what accepts a delivery.
//
// This module reads the bindings for a page of workflows (two queries, however
// long the page) and resolves the one trigger that is really in effect. Every
// surface that describes a workflow — HTTP, the conversation/MCP tools, `sk`,
// the cockpit — spreads the same `workflowTriggerView` so they cannot disagree.

import { z } from "@hono/zod-openapi";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { webhooksInbound, workflowsSchedules } from "../db/schema/index.ts";
import type { WorkflowTrigger } from "../workflows/types.ts";
import { nextScheduleTime } from "./workflow-automation-view.ts";

export const WorkflowScheduleBindingSchema = z
  .object({
    id: z.string(),
    cron: z.string(),
    timezone: z.string(),
    paused: z.boolean(),
    execution_mode: z.enum(["dev", "prod"]),
    /** Non-null while the scheduler refuses to admit a run (e.g. no execution authority). */
    admission_hold: z.object({ reason_code: z.string(), observed_at: z.string() }).nullable(),
    /** Null while paused or held — a schedule that will not fire has no next fire. */
    next_fire_at: z.string().nullable(),
    last_enqueued_at: z.string().nullable(),
  })
  .openapi("WorkflowScheduleBinding");

export const EffectiveTriggerSchema = z
  .object({
    kind: z.enum(["schedule", "webhook", "request"]),
    /** Where the answer came from: a bound row, the definition alone, or neither. */
    source: z.enum(["binding", "definition", "default"]),
    /**
     * `declared_unbound`: the definition names a schedule/webhook but no bound
     * row exists, so nothing fires it.
     */
    state: z.enum(["active", "paused", "held", "declared_unbound"]),
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

/**
 * The bound schedule and active-webhook count for each workflow id. Exactly two
 * queries regardless of how many ids are passed (none when the list is empty).
 * Ids with no binding are absent from the map; read them with `bindingFor`.
 */
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
        last_enqueued_at: workflowsSchedules.last_enqueued_at,
      })
      .from(workflowsSchedules)
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
    const firing = !s.paused && s.admission_hold === null;
    out.set(s.workflow_id, {
      webhooks_active: 0,
      schedule: {
        id: s.id,
        cron: s.cron,
        timezone: s.timezone,
        paused: s.paused,
        execution_mode: s.execution_mode,
        admission_hold: s.admission_hold ?? null,
        next_fire_at: firing ? nextScheduleTime(s.cron, s.timezone, now) : null,
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

export function bindingFor(
  bindings: ReadonlyMap<string, TriggerBinding>,
  workflowId: string,
): TriggerBinding {
  return bindings.get(workflowId) ?? UNBOUND;
}

/**
 * Precedence: a bound schedule row beats everything (the scheduler fires from
 * the row, whatever the definition says); then active webhook rows; then the
 * definition's own trigger — which, for a schedule or webhook, means it was
 * declared but never bound and does not fire; else the request default.
 */
export function resolveEffectiveTrigger(
  definitionTrigger: WorkflowTrigger | null | undefined,
  binding: TriggerBinding,
): EffectiveTrigger {
  const schedule = binding.schedule;
  if (schedule) {
    const state = schedule.paused ? "paused" : schedule.admission_hold ? "held" : "active";
    return { kind: "schedule", source: "binding", state };
  }
  if (binding.webhooks_active > 0) return { kind: "webhook", source: "binding", state: "active" };
  if (definitionTrigger?.kind === "schedule" || definitionTrigger?.kind === "webhook") {
    return { kind: definitionTrigger.kind, source: "definition", state: "declared_unbound" };
  }
  if (definitionTrigger?.kind === "request") {
    return { kind: "request", source: "definition", state: "active" };
  }
  return { kind: "request", source: "default", state: "active" };
}

/** The three trigger fields every workflow representation carries. */
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
