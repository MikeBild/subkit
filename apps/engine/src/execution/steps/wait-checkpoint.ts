// Restart-safety checkpoints for the two pausing step kinds (`wait` and
// `wait_for_event`). One row per in-flight wait, written before the pause
// begins and cleared when it ends; `reapOrphanedWaits` resumes whatever
// survived a process death.
//
// A checkpoint is only meaningful for a run the reaper can actually resume.
// `workflow_waits.workflow_id` carries a NOT NULL foreign key to `workflows`,
// and the reaper re-enqueues `execution.run` with that id to reload the
// definition. Draft and single-step runs have neither: `resolveDefinition`
// synthesises their `workflow_id` (`persist_workflow_refs: false`) and the
// engine deliberately writes NULL for it on the `executions` row, because the
// definition lives only in the request that started the run.
//
// Writing the synthetic id here therefore fails the foreign key outright — in
// production a `dry_run_workflow` over a draft containing a
// `wait_human_confirmation` step crashed with
// `workflow_waits_workflow_id_fkey`, which surfaced to the author as the whole
// dry run failing at an unrelated step. Skipping the checkpoint is not a
// workaround for that constraint but the honest reading of it: a run whose
// definition was never persisted cannot be resumed after a restart, so there is
// nothing truthful to check point. The pause itself still works in-process.

import { and, eq } from "drizzle-orm";
import { workflowWaits } from "../../db/schema/workflow_waits.ts";
import type { StepRunContext } from "../types.ts";

/** True when this run's `workflow_id` names a real row and a checkpoint can be
 *  resumed. False for draft / single-step runs. */
export function isCheckpointable(ctx: StepRunContext): boolean {
  return ctx.persist_workflow_refs;
}

/** Checkpoint an in-flight wait. Idempotent on conflict, so a step retry does
 *  not duplicate. No-op for a run that cannot be resumed. */
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

/** Clear the checkpoint whether the wait completed or aborted. The reaper only
 *  acts on rows that survived a process death; a graceful exit clears its own. */
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
