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
import { webhooksInbound, workflows, workflowsSchedules } from "../db/schema/index.ts";
import type { WorkflowTrigger } from "../workflows/types.ts";
import { scheduleNeedsActivation } from "./automation-status.ts";
import { nextScheduleFire } from "./next-fire.ts";

/**
 * Whether a bound schedule fires. `activation_required` is the same predicate
 * the schedule automation status reports (`scheduleNeedsActivation`): a draft
 * or archived workflow, or one without a committed version, never runs from
 * its schedule — the reconciler skips archived rows and admission refuses the
 * rest.
 */
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
    /** Non-null while the scheduler refuses to admit a run (e.g. no execution authority). */
    admission_hold: z
      .object({
        reason_code: z.enum(["execution_authority_required", "execution_authority_unavailable"]),
        observed_at: z.string(),
      })
      .nullable(),
    /** Whether this schedule fires; paused wins, then activation, then an admission hold. */
    state: ScheduleBindingStateSchema,
    /**
     * When it really fires next (calendar gates applied; see scheduler/next-fire.ts).
     * Null unless `state` is `active`, or when the gates close every day for too long to name.
     */
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

/** Paused wins (the operator stopped it), then activation, then an admission hold. */
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

/**
 * Precedence — only what fires may outrank what fires:
 *   1. a bound schedule that fires (the scheduler fires from the row, whatever
 *      the definition says);
 *   2. active webhook rows — still starting runs even when a schedule beside
 *      them is paused, held or waiting for activation;
 *   3. a bound schedule that does not fire, in its own state;
 *   4. the definition's own trigger — for a schedule or webhook, declared but
 *      never bound, so nothing fires it;
 *   5. the request default.
 */
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
