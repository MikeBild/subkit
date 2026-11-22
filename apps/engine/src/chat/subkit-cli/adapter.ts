import type { Db } from "../../db/client.ts";
import { cliNotificationInbox } from "../../db/schema/notifications.ts";
import { logger } from "../../logging/index.ts";
import type { NotificationAdapter } from "../../notifications/service.ts";
import { classifyEvent } from "../../webhooks/events/catalog.ts";
import type { ChatDelivery, OutboundSendResult } from "../types.ts";

export class SubkitCliAdapter implements NotificationAdapter {
  readonly platform = "sk_cli" as const;

  constructor(private readonly db: Db) {}

  async send(delivery: ChatDelivery): Promise<OutboundSendResult> {
    const notification = delivery.notification;
    const severity = notification?.severity ?? "info";
    const event_type = notification?.event_type ?? "notification";
    const event_payload = notification?.event_payload ?? null;
    const classification = classifyEvent(event_type, event_payload);
    if (!classification.actionable) {
      logger.debug({
        module: "notifications",
        action: "sk_cli.skipped_non_actionable",
        tenant_id: delivery.tenant_id,
        event_type,
      });
      return { skipped: "not_actionable" };
    }

    const inserted = await this.db
      .insert(cliNotificationInbox)
      .values({
        tenant_id: delivery.tenant_id,
        severity,
        event_type,
        event_payload,
        actionable: classification.actionable,
        resource_type: classification.resource_type,
        resource_id: classification.resource_id,
      })
      .returning({ id: cliNotificationInbox.id });

    const row = inserted[0];
    if (!row) throw new Error("sk_cli: failed to insert cli_notification_inbox row");

    logger.debug({
      module: "notifications",
      action: "sk_cli.delivered",
      msg: "notification persisted to subkit CLI inbox",
      tenant_id: delivery.tenant_id,
      event_type,
      severity,
      inbox_id: row.id,
    });

    return { platform_message_id: String(row.id) };
  }
}
