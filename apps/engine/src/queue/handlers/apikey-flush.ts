// Worker for `apikey.last-used-flush`. In P4 this is a placeholder that
// logs the dequeue — a future phase will flush cached last-used timestamps
// from the in-memory auth layer into the api_keys table.

import type { Job, PgBoss } from "pg-boss";
import { logger } from "../../logging/logger.ts";
import { APIKEY_FLUSH_QUEUE } from "../queues.ts";

interface ApiKeyFlushJob {
  reason?: string;
}

export async function registerApiKeyFlushHandler(boss: PgBoss): Promise<string> {
  const workerId = await boss.work<ApiKeyFlushJob>(
    APIKEY_FLUSH_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 10 },
    async (jobs: Job<ApiKeyFlushJob>[]) => {
      for (const job of jobs) {
        logger.debug({
          module: "queue",
          action: "job.dequeued",
          msg: "apikey.last-used-flush dequeued",
          queue: APIKEY_FLUSH_QUEUE,
          job_id: job.id,
        });
      }
    },
  );
  return workerId;
}
