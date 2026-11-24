import { and, count, eq } from "drizzle-orm";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import type { Db } from "../../db/client.ts";
import {
  type NotificationChannelRow,
  notificationChannels,
  notificationRules,
} from "../../db/schema/notifications.ts";
import { logger } from "../../logging/index.ts";
import type { NotificationSeverity } from "../matcher.ts";
import { auditedBy, type NotificationActor } from "./actor.ts";

export type { NotificationChannelRow };

export class ChannelInUseError extends Error {
  constructor(readonly rule_count: number) {
    super("channel_in_use");
    this.name = "ChannelInUseError";
  }
}

interface CreateChannelInput {
  workspace_id: string;
  channel_id: string;
  platform: string;
  default_severity?: NotificationSeverity | undefined;
  rate_limit_per_minute?: number | undefined;
  active?: boolean | undefined;
}

interface UpdateChannelInput {
  default_severity?: NotificationSeverity | undefined;
  rate_limit_per_minute?: number | undefined;
  active?: boolean | undefined;
}

export async function listChannels(db: Db, tenantId: string): Promise<NotificationChannelRow[]> {
  return db.select().from(notificationChannels).where(eq(notificationChannels.tenant_id, tenantId));
}

export async function createChannel(
  db: Db,
  actor: NotificationActor,
  input: CreateChannelInput,
): Promise<NotificationChannelRow> {
  const [row] = await db
    .insert(notificationChannels)
    .values({
      tenant_id: actor.tenant_id,
      workspace_id: input.workspace_id,
      channel_id: input.channel_id,
      platform: input.platform,
      default_severity: input.default_severity ?? "info",
      rate_limit_per_minute: input.rate_limit_per_minute ?? 60,
      active: input.active ?? true,
    })
    .returning();
  if (!row) throw new Error("notifications: insert failed");
  await auditAwait(
    {
      ...auditedBy(actor),
      action: AuditAction.NOTIFICATION_CHANNEL_CREATED,
      resource_type: "notification_channel",
      resource_id: row.id,
      result: "success",
      metadata: {
        platform: row.platform,
        workspace_id: row.workspace_id,
        channel_id: row.channel_id,
      },
    },
    db,
  );
  return row;
}

export async function updateChannel(
  db: Db,
  actor: NotificationActor,
  id: string,
  input: UpdateChannelInput,
): Promise<NotificationChannelRow | null> {
  const updates: Partial<NotificationChannelRow> = { updated_at: new Date() };
  if (input.default_severity !== undefined) updates.default_severity = input.default_severity;
  if (input.rate_limit_per_minute !== undefined)
    updates.rate_limit_per_minute = input.rate_limit_per_minute;
  if (input.active !== undefined) updates.active = input.active;
  const [row] = await db
    .update(notificationChannels)
    .set(updates)
    .where(
      and(eq(notificationChannels.tenant_id, actor.tenant_id), eq(notificationChannels.id, id)),
    )
    .returning();
  if (!row) return null;
  await auditAwait(
    {
      ...auditedBy(actor),
      action: AuditAction.NOTIFICATION_CHANNEL_UPDATED,
      resource_type: "notification_channel",
      resource_id: row.id,
      result: "success",
      metadata: { changed_fields: Object.keys(updates).filter((k) => k !== "updated_at") },
    },
    db,
  );
  return row;
}

async function countRulesTargeting(db: Db, row: NotificationChannelRow): Promise<number> {
  const [result] = await db
    .select({ rule_count: count() })
    .from(notificationRules)
    .where(
      and(
        eq(notificationRules.tenant_id, row.tenant_id),
        eq(notificationRules.target_workspace_id, row.workspace_id),
        eq(notificationRules.target_channel_id, row.channel_id),
      ),
    );
  return result?.rule_count ?? 0;
}

export async function deleteChannel(
  db: Db,
  actor: NotificationActor,
  id: string,
): Promise<boolean> {
  const scoped = and(
    eq(notificationChannels.tenant_id, actor.tenant_id),
    eq(notificationChannels.id, id),
  );
  const [row] = await db.select().from(notificationChannels).where(scoped).limit(1);
  if (!row) return false;
  const ruleCount = await countRulesTargeting(db, row);
  if (ruleCount > 0) {
    logger.warn({
      module: "notifications",
      action: "channel.delete.refused",
      msg: "channel is still targeted by notification rules",
      tenant_id: actor.tenant_id,
      channel_id: id,
      rule_count: ruleCount,
    });
    throw new ChannelInUseError(ruleCount);
  }
  const deleted = await db
    .delete(notificationChannels)
    .where(scoped)
    .returning({ id: notificationChannels.id });
  if (deleted.length === 0) return false;
  await auditAwait(
    {
      ...auditedBy(actor),
      action: AuditAction.NOTIFICATION_CHANNEL_DELETED,
      resource_type: "notification_channel",
      resource_id: id,
      result: "success",
      metadata: {},
    },
    db,
  );
  return true;
}
