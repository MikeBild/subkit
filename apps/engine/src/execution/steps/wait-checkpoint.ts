import { and, eq } from "drizzle-orm";
import { workflowWaits } from "../../db/schema/workflow_waits.ts";
import type { StepRunContext } from "../types.ts";

function isCheckpointable(ctx: StepRunContext): boolean {
  return ctx.persist_workflow_refs;
}

export async function writeWaitCheckpoint(
  ctx: StepRunContext,
  stepId: string,
  sleepUntil: Date,
): Promise<void> {
  if (!isCheckpointable(ctx)) return;
  await ctx.db
    .insert(workflowWaits)
    .values({
      tenant_id: ctx.tenant_id,
      execution_id: ctx.execution_id,
      workflow_id: ctx.workflow_id,
      step_id: stepId,
      sleep_until_ts: sleepUntil,
    })
    .onConflictDoUpdate({
      target: [workflowWaits.tenant_id, workflowWaits.execution_id, workflowWaits.step_id],
      set: { sleep_until_ts: sleepUntil, updated_at: new Date() },
    });
}

export async function clearWaitCheckpoint(ctx: StepRunContext, stepId: string): Promise<void> {
  if (!isCheckpointable(ctx)) return;
  await ctx.db
    .delete(workflowWaits)
    .where(
      and(
        eq(workflowWaits.tenant_id, ctx.tenant_id),
        eq(workflowWaits.execution_id, ctx.execution_id),
        eq(workflowWaits.step_id, stepId),
      ),
    );
}
