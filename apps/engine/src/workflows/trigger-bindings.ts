import { and, eq } from "drizzle-orm";
import { recordWorkflowScheduleNotBound as recordWorkflowScheduleNotBoundAudit } from "../audit/recorders/index.ts";
import type { AuditActorType } from "../audit/types.ts";
import type { Executor } from "../db/client.ts";
import { workflows } from "../db/schema/index.ts";
import { logger } from "../logging/index.ts";
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
  actor_type?: AuditActorType,
  binding_id?: string,
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
        ...(actor_type !== undefined ? { actor_type } : {}),
        ...(binding_id ? { binding_id } : {}),
      },
      exec,
    );
    await scheduleRepo.unbindFromWorkflow(exec, tenant_id, workflow_id, actor_id, actor_type);
    return;
  }
  if (trigger.kind === "schedule") {
    await scheduleRepo.bindFromWorkflow(exec, {
      tenant_id,
      workflow_id,
      trigger,
      actor_id,
      ...(actor_type !== undefined ? { actor_type } : {}),
    });
    await inboundService.unbindFromWorkflow(
      tenant_id,
      workflow_id,
      { actor_id, ...(actor_type !== undefined ? { actor_type } : {}) },
      exec,
      "trigger",
    );
    return;
  }
  await inboundService.unbindFromWorkflow(
    tenant_id,
    workflow_id,
    { actor_id, ...(actor_type !== undefined ? { actor_type } : {}) },
    exec,
    "trigger",
  );
  await scheduleRepo.unbindFromWorkflow(exec, tenant_id, workflow_id, actor_id, actor_type);
  const [row] = await exec
    .select({ description: workflows.description })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, workflow_id)))
    .limit(1);
  const phrase = detectSchedulePhrases({
    name: def.name,
    description: row?.description ?? def.description ?? null,
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
      ...(actor_type !== undefined ? { actor_type } : {}),
      executor: exec,
      workflow_id,
      slug: workflow_slug,
      matched_phrases: phrase.matched_phrases,
    });
  }
}
