// Thin wrapper: register the event.fanout worker.
//
// Jobs on the `event.fanout` queue carry a single `{event_row_id}`
// envelope. The worker pulls the matching outbox row and passes it to
// the webhook fanout service, which enqueues downstream
// `webhook.deliver` jobs for every matching subscription.

import type { Job, PgBoss } from "pg-boss";
import type { ChatAdapterRegistry } from "../../chat/registry.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import type { AdapterResolver } from "../../notifications/service.ts";
import { fanoutEventRow, makeRegistryAdapterResolver } from "../../webhooks/outbound/fanout.ts";

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
    { batchSize: 5, pollingIntervalSeconds: 1 },
    async (jobs: Job<EventFanoutJob>[]) => {
      for (const j of jobs) {
        try {
          await fanoutEventRow(
            db,
            boss,
            j.data.event_row_id,
            resolver ? { notificationAdapterResolver: resolver } : {},
          );
        } catch (err) {
          logger.error({
            module: "webhooks.outbound",
            action: "fanout.handler_error",
            msg: "event.fanout handler threw",
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
