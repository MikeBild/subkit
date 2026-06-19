// Thin wrapper: register the webhook.deliver worker.

import type { PgBoss } from "pg-boss";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import { registerDeliveryWorker } from "../../webhooks/outbound/delivery-worker.ts";

export interface RegisterWebhookDeliverOptions {
  boss: PgBoss;
  db: Db;
}

export async function registerWebhookDeliverHandler(
  opts: RegisterWebhookDeliverOptions,
): Promise<string | null> {
  const handle = await registerDeliveryWorker({ boss: opts.boss, db: opts.db });
  logger.info({
    module: "queue",
    action: "webhook_deliver.registered",
    msg: "webhook.deliver worker registered",
    worker_id: handle.workerId,
  });
  return handle.workerId;
}
