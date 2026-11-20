import type { Job, PgBoss } from "pg-boss";
import type { Db } from "../../db/client.ts";
import { log } from "../../logging/logger.ts";
import type { TaskServiceDeps } from "../../tasks/index.ts";
import { withActiveTenantJobContext } from "../job-context.ts";
import { TASK_RUN_TURN_DLQ } from "../queues.ts";
import { type TaskRunTurnJob, TaskRunTurnJobSchema } from "./task-run-turn.ts";

interface RegisterTaskRunTurnDlqOptions {
  boss: PgBoss;
  db: Db;
  service?: Partial<TaskServiceDeps>;
}

export async function handleTaskRunTurnDeadLetter(
  job: Job<TaskRunTurnJob>,
  db: Db,
  service: Partial<TaskServiceDeps> = {},
): Promise<void> {
  const parsed = TaskRunTurnJobSchema.safeParse(job.data);
  if (!parsed.success) {
    log.queue.job.failed({
      msg: "task.run-turn.dlq job has a malformed payload — dropped",
      queue: TASK_RUN_TURN_DLQ,
      job_id: job.id,
      error: "task_run_turn_payload_invalid",
    });
    return;
  }
  const data = parsed.data;
  await withActiveTenantJobContext(data, db, async () => {
    const driver = await import("../../tasks/run-driver.ts");
    const { withTaskRunTrace } = await import("../../tasks/trace.ts");
    const loaded = await driver.loadTaskRun(db, data.tenant_id, data.task_run_id);
    if (!loaded || loaded.run.task_id !== data.task_id) {
      log.queue.job.completed({
        msg: "task.run-turn.dlq job — no such run, no-op",
        queue: TASK_RUN_TURN_DLQ,
        job_id: job.id,
      });
      return;
    }
    const advance = await withTaskRunTrace(loaded.run, () =>
      driver.advanceTaskRun(
        db,
        {
          tenant_id: data.tenant_id,
          task_run_id: loaded.run.id,
          now: new Date(),
          dead_letter: true,
        },
        service,
      ),
    );
    log.queue.job.completed({
      msg: "task.run-turn.dlq job — run reconciled",
      queue: TASK_RUN_TURN_DLQ,
      job_id: job.id,
      tenant_id: data.tenant_id,
      task_run_id: loaded.run.id,
      advance,
    });
  });
}

export async function registerTaskRunTurnDlqHandler(
  opts: RegisterTaskRunTurnDlqOptions,
): Promise<string> {
  const { boss, db } = opts;
  const workerId = await boss.work<TaskRunTurnJob>(
    TASK_RUN_TURN_DLQ,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async (jobs: Job<TaskRunTurnJob>[]) => {
      for (const job of jobs) await handleTaskRunTurnDeadLetter(job, db, opts.service);
    },
  );
  log.queue.worker.registered({ msg: "task.run-turn.dlq worker registered", worker_id: workerId });
  return workerId;
}
