// Worker for the `workflow.repair` queue.
//
// The job payload carries the tenant + workflow + failing step +
// optionally a connector / endpoint key. The handler calls into the
// self-healing service, which runs the full loop (drift → LLM →
// classify → fixture → auto-apply or park) end-to-end.

import type { Job, PgBoss } from "pg-boss";
import type { Db } from "../../db/client.ts";
import { log } from "../../logging/logger.ts";
import { runSelfHealingLoop } from "../../self-healing/service.ts";
import type { WorkflowRepairJob } from "../../self-healing/types.ts";
import { withJobContext } from "../job-context.ts";

export const WORKFLOW_REPAIR_QUEUE = "workflow.repair" as const;

export interface RegisterWorkflowRepairOptions {
  boss: PgBoss;
  db: Db;
}

async function handleOne(job: Job<WorkflowRepairJob>, db: Db): Promise<void> {
  const data = job.data;
  log.queue.job.dequeued({
    msg: "workflow.repair job dequeued",
    queue: WORKFLOW_REPAIR_QUEUE,
    job_id: job.id,
    tenant_id: data.tenant_id,
    workflow_id: data.workflow_id,
    execution_id: data.execution_id,
    step_id: data.step_id,
  });
  const started = Date.now();
  // rss baseline around the LLM-heavy self-healing loop, so the success
  // log attributes the transient to THIS tenant's repair run.
  const rssBefore = process.memoryUsage().rss;
  try {
    const result = await runSelfHealingLoop(data, db);
    log.queue.job.completed({
      msg: "workflow.repair job completed",
      queue: WORKFLOW_REPAIR_QUEUE,
      job_id: job.id,
      drift_detected: result.drift_detected,
      patch_candidate_id: result.patch_candidate_id,
      classification: result.classification,
      auto_applied: result.auto_applied,
      reason: result.reason,
      duration_ms: Date.now() - started,
      rss_mb: Math.round((process.memoryUsage().rss / 1048576) * 10) / 10,
      rss_delta_mb: Math.round(((process.memoryUsage().rss - rssBefore) / 1048576) * 10) / 10,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.queue.job.failed({
      msg: "workflow.repair job failed",
      queue: WORKFLOW_REPAIR_QUEUE,
      job_id: job.id,
      error: message,
      duration_ms: Date.now() - started,
    });
    throw err;
  }
}

export async function registerWorkflowRepairHandler(
  opts: RegisterWorkflowRepairOptions,
): Promise<string> {
  const { boss, db } = opts;
  const workerId = await boss.work<WorkflowRepairJob>(
    WORKFLOW_REPAIR_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async (jobs: Job<WorkflowRepairJob>[]) => {
      for (const job of jobs) {
        await withJobContext(job.data, () => handleOne(job, db));
      }
    },
  );
  log.queue.worker.registered({
    msg: "workflow.repair worker registered",
    worker_id: workerId,
  });
  return workerId;
}

export async function enqueueRepair(
  boss: PgBoss,
  payload: WorkflowRepairJob,
): Promise<string | null> {
  return await boss.send(WORKFLOW_REPAIR_QUEUE, payload);
}
