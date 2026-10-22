import type webpush from "web-push";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import {
  type CockpitPushOutcome,
  type CockpitPushSendResult,
  sendCockpitPushNotifications,
} from "../identity/index.ts";
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
  subscription_ids: string[];
  new_items: number;
  skipped_same_device?: number;
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
    });
    return null;
  }
  const result = await sendCockpitPushNotifications({
    db: input.db,
    tenant_id: input.tenant_id,
    subscription_ids: input.subscription_ids,
    subject: input.subject,
    ...(input.now ? { now: input.now } : {}),
    ...(input.send ? { send: input.send } : {}),
  });
  const targets = new Map<string, CockpitPushOutcome[]>();
  for (const outcome of result.outcomes) {
    const target = `${outcome.kind}:${outcome.installation_id ?? ""}`;
    targets.set(target, [...(targets.get(target) ?? []), outcome]);
    if (outcome.status === "gone")
      logger.info({
        module: "notifications",
        action: "cockpit_push.subscription_gone",
        msg: "cockpit push endpoint expired and the subscription was removed",
        tenant_id: input.tenant_id,
        kind: outcome.kind,
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
        kind: outcome.kind,
        installation_id: outcome.installation_id,
        status_code: outcome.status_code ?? null,
        error_name: outcome.error_name,
        endpoint_host: outcome.endpoint_host,
      });
  }
  for (const outcomes of targets.values()) {
    const [first] = outcomes;
    if (!first) continue;
    logger.info({
      module: "notifications",
      action: "cockpit_push.sent",
      msg: "cockpit push delivered",
      tenant_id: input.tenant_id,
      kind: first.kind,
      installation_id: first.installation_id,
      attempted: outcomes.length,
      delivered: outcomes.filter((outcome) => outcome.status === "delivered").length,
      new_items: input.new_items,
      skipped_same_device: input.skipped_same_device ?? 0,
    });
  }
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
