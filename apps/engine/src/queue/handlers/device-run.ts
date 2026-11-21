import type { Job, PgBoss } from "pg-boss";
import type { Db } from "../../db/client.ts";
import { handleDeviceWaitJob, interruptDeviceRun, startDeviceRun } from "../../devices/waiting.ts";
import { log } from "../../logging/index.ts";
import { withActiveTenantJobContext } from "../job-context.ts";
import {
  DEVICE_WAIT_QUEUE,
  type DeviceWaitJob,
  EXECUTION_RUN_DEVICE_DLQ,
  EXECUTION_RUN_DEVICE_QUEUE,
  type ExecutionRunJob,
} from "../queues.ts";
import { registerExecutionRunHandler } from "./execution-run.ts";

interface RegisterDeviceRunOptions {
  boss: PgBoss;
  db: Db;
}

export interface DeviceRunWorkers {
  run: string;
  dead_letter: string;
  wait: string;
}

export async function registerDeviceRunHandlers(
  opts: RegisterDeviceRunOptions,
): Promise<DeviceRunWorkers> {
  const { boss, db } = opts;
  const run = await registerExecutionRunHandler({
    boss,
    db,
    queue: EXECUTION_RUN_DEVICE_QUEUE,
    gate: (job) => startDeviceRun(db, boss, job.data, job.retryCount),
  });
  const dead_letter = await boss.work<ExecutionRunJob>(
    EXECUTION_RUN_DEVICE_DLQ,
    { batchSize: 1 },
    async (jobs: Job<ExecutionRunJob>[]) => {
      for (const job of jobs) {
        const execution_id = job.data.execution_id;
        if (!execution_id) continue;
        await withActiveTenantJobContext(job.data, db, () =>
          interruptDeviceRun(db, job.data.tenant_id, execution_id),
        );
        log.queue.job.completed({
          msg: "execution.run.device.dlq job — run closed as interrupted",
          queue: EXECUTION_RUN_DEVICE_DLQ,
          job_id: job.id,
          execution_id,
        });
      }
    },
  );
  const wait = await boss.work<DeviceWaitJob>(
    DEVICE_WAIT_QUEUE,
    { batchSize: 1 },
    async (jobs: Job<DeviceWaitJob>[]) => {
      for (const job of jobs)
        await withActiveTenantJobContext(job.data, db, () =>
          handleDeviceWaitJob(db, boss, job.data),
        );
    },
  );
  return { run, dead_letter, wait };
}
