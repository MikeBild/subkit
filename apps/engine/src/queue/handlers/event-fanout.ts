// Thin wrapper: register the event.fanout worker.
//
// Jobs on the `event.fanout` queue carry a single `{event_row_id}`
// envelope. The worker pulls the matching outbox row and passes it to
// the webhook fanout service, which enqueues downstream
// `webhook.deliver` jobs for every matching subscription.

import type { Job, PgBoss } from "pg-boss";

import type { ChatAdapterRegistry } from "../../chat/registry.ts";
import type { Db } from "../../db/client.ts";
import { errorFields, log, logger } from "../../logging/logger.ts";
import type { AdapterResolver } from "../../notifications/service.ts";
import { fanoutEventRow, makeRegistryAdapterResolver } from "../../webhooks/outbound/fanout.ts";
import { withJobContext } from "../job-context.ts";

export const EVENT_FANOUT_QUEUE = "event.fanout" as const;

export interface EventFanoutJob {
  event_row_id: number;
}

export interface RegisterEventFanoutOptions {
  boss: PgBoss;
  db: Db;
  /** Optional chat adapter registry. When provided the fanout worker
   * will run the notification dispatch path for each outbox event and
   * resolve per-channel adapters out of this registry. */
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
    // batchSize:1 so one failing event doesn't drag its batch-mates: a
    // failure now fails exactly its own job, which pg-boss then retries.
    { batchSize: 1, pollingIntervalSeconds: 1 },
    async (jobs: Job<EventFanoutJob>[]) => {
      for (const j of jobs) {
        // Wrap the per-job body in the queue context bridge like every other
        // handler. The envelope ({ event_row_id }) carries no trace_id/tenant_id,
        // so this only stamps request_source:"queue" on the worker's own
        // queue-level logs — fanoutEventRow re-establishes the per-row tenant
        // from the outbox row itself — but it keeps the correlation surface
        // uniform so these lines aren't request_source-blind.
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
            // Rethrow so pg-boss marks the job failed and RETRIES it.
            // Previously the error was swallowed → pg-boss saw success →
            // the event's webhook/notification deliveries were lost with no
            // retry. The delivery event_id is derived deterministically from
            // the outbox row id (see fanout.ts), so a retried fan-out is
            // idempotent at the receiver.
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
