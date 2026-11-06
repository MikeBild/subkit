import { and, eq } from "drizzle-orm";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import type { Db } from "../../db/client.ts";
import { type NotificationRuleRow, notificationRules } from "../../db/schema/notifications.ts";
import type { NotificationSeverity } from "../matcher.ts";
import { type DispatchResult, dispatchEvent } from "../service.ts";
import { auditedBy, type NotificationActor } from "./actor.ts";

export type { NotificationRuleRow };

export interface CreateRuleInput {
  name: string;
  event_pattern: string;
  workflow_pattern?: string | undefined;
  severity?: NotificationSeverity | undefined;
  request_source_filter?: string[] | null | undefined;
  target_workspace_id: string;
  target_channel_id: string;
  active?: boolean | undefined;
}

export type UpdateRuleInput = { [K in keyof CreateRuleInput]?: CreateRuleInput[K] | undefined };

export interface TestRuleInput {
  event_type: string;
  workflow_id?: string | null | undefined;
  workflow_slug?: string | null | undefined;
  severity?: NotificationSeverity | undefined;
  payload?: Record<string, unknown> | null | undefined;
}

export interface TestRuleContext {
  tenant_id: string;
  actor_type: NotificationActor["kind"];
  actor_id: string;
  trace_id: string;
  request_source: string;
}

export async function listRules(db: Db, tenantId: string): Promise<NotificationRuleRow[]> {
  return db.select().from(notificationRules).where(eq(notificationRules.tenant_id, tenantId));
}

export async function createRule(
  db: Db,
  actor: NotificationActor,
  input: CreateRuleInput,
): Promise<NotificationRuleRow> {
  const [row] = await db
    .insert(notificationRules)
    .values({
      tenant_id: actor.tenant_id,
      name: input.name,
      event_pattern: input.event_pattern,
      workflow_pattern: input.workflow_pattern ?? "*",
      severity: input.severity ?? "info",
      request_source_filter: input.request_source_filter ?? null,
      target_workspace_id: input.target_workspace_id,
      target_channel_id: input.target_channel_id,
      active: input.active ?? true,
    })
    .returning();
  if (!row) throw new Error("notifications: rule insert failed");
  await auditAwait(
    {
      ...auditedBy(actor),
      action: AuditAction.NOTIFICATION_RULE_CREATED,
      resource_type: "notification_rule",
      resource_id: row.id,
      result: "success",
      metadata: {
        name: row.name,
        event_pattern: row.event_pattern,
        severity: row.severity,
      },
    },
    db,
  );
  return row;
}

export async function updateRule(
  db: Db,
  actor: NotificationActor,
  id: string,
  input: UpdateRuleInput,
): Promise<NotificationRuleRow | null> {
  const updates: Partial<NotificationRuleRow> = { updated_at: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.event_pattern !== undefined) updates.event_pattern = input.event_pattern;
  if (input.workflow_pattern !== undefined) updates.workflow_pattern = input.workflow_pattern;
  if (input.severity !== undefined) updates.severity = input.severity;
  if (input.request_source_filter !== undefined)
    updates.request_source_filter = input.request_source_filter;
  if (input.target_workspace_id !== undefined)
    updates.target_workspace_id = input.target_workspace_id;
  if (input.target_channel_id !== undefined) updates.target_channel_id = input.target_channel_id;
  if (input.active !== undefined) updates.active = input.active;
  const [row] = await db
    .update(notificationRules)
    .set(updates)
    .where(and(eq(notificationRules.tenant_id, actor.tenant_id), eq(notificationRules.id, id)))
    .returning();
  if (!row) return null;
  await auditAwait(
    {
      ...auditedBy(actor),
      action: AuditAction.NOTIFICATION_RULE_UPDATED,
      resource_type: "notification_rule",
      resource_id: row.id,
      result: "success",
      metadata: { changed_fields: Object.keys(updates).filter((k) => k !== "updated_at") },
    },
    db,
  );
  return row;
}

export async function deleteRule(db: Db, actor: NotificationActor, id: string): Promise<boolean> {
  const deleted = await db
    .delete(notificationRules)
    .where(and(eq(notificationRules.tenant_id, actor.tenant_id), eq(notificationRules.id, id)))
    .returning({ id: notificationRules.id });
  if (deleted.length === 0) return false;
  await auditAwait(
    {
      ...auditedBy(actor),
      action: AuditAction.NOTIFICATION_RULE_DELETED,
      resource_type: "notification_rule",
      resource_id: id,
      result: "success",
      metadata: {},
    },
    db,
  );
  return true;
}

export async function testRule(
  db: Db,
  ctx: TestRuleContext,
  id: string,
  input: TestRuleInput,
): Promise<DispatchResult | null> {
  const [rule] = await db
    .select()
    .from(notificationRules)
    .where(and(eq(notificationRules.tenant_id, ctx.tenant_id), eq(notificationRules.id, id)))
    .limit(1);
  if (!rule) return null;
  const event = {
    tenant_id: ctx.tenant_id,
    type: input.event_type,
    workflow_id: input.workflow_id ?? null,
    workflow_slug: input.workflow_slug ?? null,
    severity: (input.severity ?? rule.severity) as NotificationSeverity,
    payload: input.payload ?? null,
  };
  const result = await dispatchEvent({ db }, event);
  await auditAwait(
    {
      tenant_id: ctx.tenant_id,
      actor_type: ctx.actor_type,
      actor_id: ctx.actor_id,
      action: AuditAction.NOTIFICATION_RULE_TESTED,
      resource_type: "notification_rule",
      resource_id: rule.id,
      result: "success",
      metadata: {
        matched: result.matched,
        delivered: result.delivered,
        event_type: event.type,
        trace_id: ctx.trace_id,
        request_source: ctx.request_source,
      },
    },
    db,
  );
  return result;
}
