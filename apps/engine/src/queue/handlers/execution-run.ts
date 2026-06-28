// Worker for the `execution.run` queue.
//
// The job payload is a small envelope that points at an existing
// executions row created when the HTTP enqueue ran. If no row exists yet
// (e.g. the scheduler fired a cron), the handler lets runExecution create
// it. The handler always resolves a tenant + workflow + input tuple
// before calling into the engine.

import type { Job, PgBoss } from "pg-boss";
import type { Db } from "../../db/client.ts";
import { runExecution } from "../../execution/engine.ts";
import { finalizeExecution } from "../../execution/state.ts";
import type { RequestSource, RunOptions } from "../../execution/types.ts";
import { log } from "../../logging/logger.ts";
import { withJobContext } from "../job-context.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../queues.ts";

export interface RegisterExecutionRunOptions {
  boss: PgBoss;
  db: Db;
}

async function handleOne(job: Job<ExecutionRunJob>, db: Db): Promise<void> {
  const data = job.data;
  log.queue.job.dequeued({
    msg: "execution.run job dequeued",
    queue: EXECUTION_RUN_QUEUE,
    job_id: job.id,
    tenant_id: data.tenant_id,
    workflow_id: data.workflow_id,
    execution_id: data.execution_id ?? null,
  });
  const started = Date.now();
  const runOptions: RunOptions = {
    request_source: (data.request_source as RequestSource) ?? "api",
    parent_execution_id: data.parent_execution_id ?? null,
    trace_id: data.trace_id ?? null,
  };
  if (data.execution_id) runOptions.existing_execution_id = data.execution_id;
  if (data.execution_mode) runOptions.execution_mode = data.execution_mode;
  try {
    const result = await runExecution({
      db,
      tenant_id: data.tenant_id,
      source: { kind: "saved", workflow_id: data.workflow_id },
      input: data.input ?? null,
      options: runOptions,
    });
    log.queue.job.completed({
      msg: "execution.run job completed",
      queue: EXECUTION_RUN_QUEUE,
      job_id: job.id,
      execution_id: result.execution_id,
      status: result.status,
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.queue.job.failed({
      msg: "execution.run job failed",
      queue: EXECUTION_RUN_QUEUE,
      job_id: job.id,
      error: message,
      duration_ms: Date.now() - started,
    });
    // runExecution only throws on EARLY errors (input-schema violation,
    // definition resolution, depth limit) — before the engine finalizes
    // the row itself. The row was pre-created `queued` by the HTTP enqueue,
    // so without this it would strand forever. Record the failure on the
    // row (CAS-guarded — a no-op if the engine already finalized it) so a
    // polling client sees a terminal state. Finalizing successfully means
    // the DB is reachable and the error was deterministic, so we do NOT
    // re-throw (a retry would just loop on the same bad input). If the
    // finalize itself fails (e.g. DB down), propagate so pg-boss retries.
    if (data.execution_id) {
      const code =
        typeof (err as { code?: unknown }).code === "string"
          ? (err as { code: string }).code
          : "execution_error";
      try {
        await finalizeExecution(db, data.tenant_id, data.execution_id, "failed", null, {
          step_id: null,
          error_code: code,
          error_message: message,
        });
        return;
      } catch {
        // fall through to re-throw the original error
      }
    }
    throw err;
  }
}

export async function registerExecutionRunHandler(
  opts: RegisterExecutionRunOptions,
): Promise<string> {
  const { boss, db } = opts;
  const workerId = await boss.work<ExecutionRunJob>(
    EXECUTION_RUN_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 1 },
    async (jobs: Job<ExecutionRunJob>[]) => {
      for (const job of jobs) {
        // Bridge the enqueuing trace_id/tenant across the queue boundary so
        // every downstream execution.* log inherits the originating context.
        await withJobContext(job.data, () => handleOne(job, db));
      }
    },
  );
  log.queue.worker.registered({
    msg: "execution.run worker registered",
    worker_id: workerId,
  });
  return workerId;
}
