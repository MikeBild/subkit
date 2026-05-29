// Reverse-binding of a workflow def's discriminated `trigger` block to
// its `webhooks_inbound` / `workflows_schedules` rows. Extracted from
// `service.ts` (which owns workflow CRUD) so neither file drifts past the
// 1000-LOC audit ceiling; the function is internal — `service.ts` calls it
// from create / update / restore. No public export of `service.ts` moves,
// so the split preserves the package's export surface.

import { recordWorkflowScheduleNotBound as recordWorkflowScheduleNotBoundAudit } from "../audit/recorders/index.ts";
import type { Db } from "../db/client.ts";
import { logger } from "../logging/logger.ts";
import {
  recordWorkflowScheduleNotBound,
  recordWorkflowTriggerKind,
} from "../observability/instrumentation.ts";
import * as scheduleRepo from "../scheduler/repo.ts";
import * as inboundService from "../webhooks/inbound/service.ts";
import { detectSchedulePhrases } from "./schedule-phrase-detector.ts";
import type { WorkflowDef } from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Apply the discriminated `trigger` block from a workflow def to its
 * reverse-bound rows in `webhooks_inbound` / `workflows_schedules`.
 * Idempotent on `(tenant_id, workflow_id)` — repeated calls with the
 * same trigger are no-ops.
 *
 * Lifecycle contract:
 *
 *   * `kind: "request"` (or no trigger) → tear down any prior
 *     webhook + schedule binding the workflow had. This is what
 *     happens when an operator removes a trigger from an existing
 *     workflow: the next save unbinds the public ingress.
 *   * `kind: "webhook"` → upsert the inbound row, tear down any
 *     stale schedule.
 *   * `kind: "schedule"` → upsert the schedule row, tear down any
 *     stale inbound binding.
 *
 * The two-arm tear-down keeps a workflow from carrying both
 * bindings simultaneously when its trigger flips between the
 * variants — without it, a `webhook → schedule` edit would leave
 * the public webhook URL live.
 */
export async function applyTriggerBindings(
  exec: Executor,
  tenant_id: string,
  workflow_id: string,
  workflow_slug: string,
  def: WorkflowDef,
  actor_id: string | null,
): Promise<void> {
  const trigger = def.trigger ?? { kind: "request" as const };
  recordWorkflowTriggerKind({ tenant_id, kind: trigger.kind });
  if (trigger.kind === "webhook") {
    await inboundService.bindFromWorkflow(
      {
        tenant_id,
        workflow_id,
        workflow_slug,
        trigger,
        actor_id,
      },
      exec,
    );
    await scheduleRepo.unbindFromWorkflow(exec, tenant_id, workflow_id, actor_id);
    return;
  }
  if (trigger.kind === "schedule") {
    await scheduleRepo.bindFromWorkflow(exec, {
      tenant_id,
      workflow_id,
      trigger,
      actor_id,
    });
    await inboundService.unbindFromWorkflow(tenant_id, workflow_id, actor_id, exec);
    return;
  }
  // "request" — make sure neither binding lingers.
  await inboundService.unbindFromWorkflow(tenant_id, workflow_id, actor_id, exec);
  await scheduleRepo.unbindFromWorkflow(exec, tenant_id, workflow_id, actor_id);
  // Defence-in-depth (Root A): the LLM authored cadence phrasing into
  // the workflow's name or description but committed with
  // `trigger.kind = "request"`. Emit a warn + audit + counter so the
  // operator sees the regression. The regex output is OBSERVABILITY
  // ONLY — it never feeds back into cron construction. The fix path
  // is in the seed skill (Phase 2): the LLM carries the schedule
  // trigger inline with `build_workflow`.
  const phrase = detectSchedulePhrases({
    name: def.name,
    description: def.description ?? null,
  });
  if (phrase.matched) {
    logger.warn({
      module: "workflows",
      action: "workflow.schedule_not_bound",
      msg: "committed workflow has cadence phrasing but no schedule trigger",
      tenant_id,
      workflow_id,
      slug: workflow_slug,
      matched_phrases: phrase.matched_phrases,
    });
    recordWorkflowScheduleNotBound({ tenant_id });
    await recordWorkflowScheduleNotBoundAudit({
      tenant_id,
      actor_id,
      executor: exec,
      workflow_id,
      slug: workflow_slug,
      matched_phrases: phrase.matched_phrases,
    });
  }
}
