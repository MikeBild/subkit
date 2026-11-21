import type { Job, PgBoss } from "pg-boss";
import type { ChatAdapterRegistry } from "../../chat/registry.ts";
import type { Db } from "../../db/client.ts";
import { errorFields, log, logger } from "../../logging/index.ts";
import type { AdapterResolver } from "../../notifications/service.ts";
import { fanoutEventRow, makeRegistryAdapterResolver } from "../../webhooks/outbound/fanout.ts";
import { withJobContext } from "../job-context.ts";

export const EVENT_FANOUT_QUEUE = "event.fanout" as const;

interface EventFanoutJob {
  event_row_id: number;
}

interface RegisterEventFanoutOptions {
  boss: PgBoss;
  db: Db;
  chatRegistry?: ChatAdapterRegistry;
}

export async function registerEventFanoutHandler(
  opts: RegisterEventFanoutOptions,
): Promise<string> {
  const { boss, db } = opts;
  const resolver: AdapterResolver | undefined = opts.chatRegistry
    ? makeRegistryAdapterResolver(opts.chatRegistry)
    : undefined;
  const workerId = await boss.work<EventFanoutJob>(
    EVENT_FANOUT_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 1 },
    async (jobs: Job<EventFanoutJob>[]) => {
      for (const j of jobs) {
        await withJobContext(j.data, async () => {
          const started = Date.now();
          try {
            await fanoutEventRow(
              db,
              boss,
              j.data.event_row_id,
              resolver ? { notificationAdapterResolver: resolver } : {},
            );
            log.queue.job.completed({
              msg: "event.fanout job completed",
              queue: EVENT_FANOUT_QUEUE,
              job_id: j.id,
              event_row_id: j.data.event_row_id,
              duration_ms: Date.now() - started,
            });
          } catch (err) {
            log.queue.job.failed({
              msg: "event.fanout job failed",
              queue: EVENT_FANOUT_QUEUE,
              job_id: j.id,
              event_row_id: j.data.event_row_id,
              ...errorFields(err),
              duration_ms: Date.now() - started,
            });
            logger.error({
              module: "webhooks.outbound",
              action: "fanout.handler_error",
              msg: "event.fanout handler threw",
              ...errorFields(err),
            });
            throw err;
          }
        });
      }
    },
  );
  logger.info({
    module: "webhooks.outbound",
    action: "worker.registered",
    msg: "event.fanout worker registered",
    worker_id: workerId,
  });
  return workerId;
}
