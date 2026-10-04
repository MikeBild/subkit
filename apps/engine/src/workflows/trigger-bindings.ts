import { recordWorkflowScheduleNotBound as recordWorkflowScheduleNotBoundAudit } from "../audit/recorders/index.ts";
import type { Executor } from "../db/client.ts";
import { logger } from "../logging/logger.ts";
import {
  recordWorkflowScheduleNotBound,
  recordWorkflowTriggerKind,
} from "../observability/instrumentation.ts";
import * as scheduleRepo from "../scheduler/repo.ts";
import * as inboundService from "../webhooks/inbound/service.ts";
import { detectSchedulePhrases } from "./schedule-phrase-detector.ts";
import type { WorkflowDef, WorkflowTrigger } from "./types.ts";

export function triggerOf(d: WorkflowDef): WorkflowTrigger {
  return d.trigger ?? { kind: "request" };
}

export async function applyTriggerBindings(
  exec: Executor,
  tenant_id: string,
  workflow_id: string,
  workflow_slug: string,
  def: WorkflowDef,
  actor_id: string | null,
): Promise<void> {
  const trigger = triggerOf(def);
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
  await inboundService.unbindFromWorkflow(tenant_id, workflow_id, actor_id, exec);
  await scheduleRepo.unbindFromWorkflow(exec, tenant_id, workflow_id, actor_id);
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
