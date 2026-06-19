// sk CLI notification adapter.
//
// The `sk_cli` pseudo-platform is outbound-only: it does not verify or
// receive inbound traffic. The notification dispatcher resolves it as a
// process-global fallback (registered at boot in `index.ts`) and routes
// matched deliveries here. Each `send()` persists ONE
// `cli_notification_inbox` row, scoped to the delivery's tenant. The CLI
// later polls `GET /v1/notifications/inbox` and acknowledges consumed
// rows. No remote API, no rate limit, no circuit breaker — a local
// INSERT.

import type { Db } from "../../db/client.ts";
import { cliNotificationInbox } from "../../db/schema/notifications.ts";
import { logger } from "../../logging/logger.ts";
import type { NotificationAdapter } from "../../notifications/service.ts";
import type { ChatDelivery } from "../types.ts";

export class SkCliAdapter implements NotificationAdapter {
  readonly platform = "sk_cli" as const;

  constructor(private readonly db: Db) {}

  async send(delivery: ChatDelivery): Promise<{ platform_message_id: string }> {
    const notification = delivery.notification;
    const severity = notification?.severity ?? "info";
    const event_type = notification?.event_type ?? "notification";
    const event_payload = notification?.event_payload ?? null;

    const inserted = await this.db
      .insert(cliNotificationInbox)
      .values({
        tenant_id: delivery.tenant_id,
        severity,
        event_type,
        event_payload,
      })
      .returning({ id: cliNotificationInbox.id });

    const row = inserted[0];
    if (!row) throw new Error("sk_cli: failed to insert cli_notification_inbox row");

    logger.debug({
      module: "notifications",
      action: "sk_cli.delivered",
      msg: "notification persisted to sk CLI inbox",
      tenant_id: delivery.tenant_id,
      event_type,
      severity,
      inbox_id: row.id,
    });

    return { platform_message_id: String(row.id) };
  }
}
