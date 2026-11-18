import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { notificationRules } from "../db/schema/index.ts";

export const DEFAULT_CLI_INBOX_EVENT_PATTERN =
  "execution.failed,connector.oauth.callback_failed,connector.auth_failed,connector.health_changed,patch.proposed";

export async function seedDefaultCliNotificationRule(
  tx: Executor,
  tenant_id: string,
): Promise<void> {
  const existing = await tx
    .select({ id: notificationRules.id })
    .from(notificationRules)
    .where(
      and(
        eq(notificationRules.tenant_id, tenant_id),
        eq(notificationRules.target_workspace_id, "_cli"),
        eq(notificationRules.target_channel_id, "_inbox"),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;

  await tx.insert(notificationRules).values({
    tenant_id,
    name: "sk CLI inbox (default)",
    event_pattern: DEFAULT_CLI_INBOX_EVENT_PATTERN,
    workflow_pattern: "*",
    severity: "info",
    request_source_filter: null,
    target_workspace_id: "_cli",
    target_channel_id: "_inbox",
    active: true,
  });
}
