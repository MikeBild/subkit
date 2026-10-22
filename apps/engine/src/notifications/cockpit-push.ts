import type webpush from "web-push";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { type CockpitPushSendResult, sendCockpitPushNotifications } from "../identity/index.ts";
import { errorFields, logger } from "../logging/logger.ts";

export function cockpitPushSubject(publicBaseUrl?: string): string | null {
  try {
    const value = (publicBaseUrl ?? getConfig().server.public_base_url).trim();
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

export async function deliverCockpitPush(input: {
  db: Db;
  tenant_id: string;
  installation_id: string;
  subscription_ids: string[];
  new_items: number;
  subject: string | null;
  now?: Date;
  send?: typeof webpush.sendNotification;
}): Promise<CockpitPushSendResult | null> {
  if (!input.subject) {
    logger.warn({
      module: "notifications",
      action: "cockpit_push.subject_unavailable",
      msg: "cockpit push skipped because server.public_base_url is not an https origin",
      tenant_id: input.tenant_id,
      installation_id: input.installation_id,
    });
    return null;
  }
  const result = await sendCockpitPushNotifications({
    db: input.db,
    tenant_id: input.tenant_id,
    installation_id: input.installation_id,
    subscription_ids: input.subscription_ids,
    subject: input.subject,
    ...(input.now ? { now: input.now } : {}),
    ...(input.send ? { send: input.send } : {}),
  });
  for (const outcome of result.outcomes) {
    if (outcome.status === "gone")
      logger.info({
        module: "notifications",
        action: "cockpit_push.subscription_gone",
        msg: "cockpit push endpoint expired and the subscription was removed",
        tenant_id: input.tenant_id,
        installation_id: outcome.installation_id,
        status_code: outcome.status_code,
        endpoint_host: outcome.endpoint_host,
      });
    else if (outcome.status === "failed")
      logger.warn({
        module: "notifications",
        action: "cockpit_push.send_failed",
        msg: "cockpit push delivery failed",
        tenant_id: input.tenant_id,
        installation_id: outcome.installation_id,
        status_code: outcome.status_code ?? null,
        error_name: outcome.error_name,
        endpoint_host: outcome.endpoint_host,
      });
  }
  if (result.attempted > 0)
    logger.info({
      module: "notifications",
      action: "cockpit_push.sent",
      msg: "cockpit push delivered",
      tenant_id: input.tenant_id,
      installation_id: input.installation_id,
      attempted: result.attempted,
      delivered: result.delivered,
      new_items: input.new_items,
    });
  return result;
}

export function logCockpitPushDispatchFailure(tenantId: string, error: unknown): void {
  logger.error({
    module: "notifications",
    action: "cockpit_push.dispatch_failed",
    msg: "cockpit push dispatch failed",
    tenant_id: tenantId,
    ...errorFields(error),
  });
}
