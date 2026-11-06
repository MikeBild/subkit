import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import type { Db } from "../../db/client.ts";
import { cliNotificationInbox, cliNotificationInboxReads } from "../../db/schema/notifications.ts";
import { auditedBy, type NotificationActor } from "./actor.ts";

interface InboxListInput {
  since: number;
  limit: number;
  unread_only?: boolean | undefined;
  actionable_only?: boolean | undefined;
}

interface InboxRow {
  id: number;
  severity: string;
  event_type: string;
  event_payload: unknown;
  actionable: boolean;
  resource_type: string | null;
  resource_id: string | null;
  created_at: Date;
  read_at: Date | null;
}

interface InboxPage {
  rows: InboxRow[];
  unread: number;
  actionable_unread: number;
}

function readJoin(userId: string | null) {
  return userId
    ? and(
        eq(cliNotificationInboxReads.inbox_id, cliNotificationInbox.id),
        eq(cliNotificationInboxReads.user_id, userId),
      )
    : sql`false`;
}

async function unreadCounts(
  db: Db,
  tenantId: string,
  userId: string | null,
): Promise<{ unread: number; actionable_unread: number }> {
  const rows = await db
    .select({
      unread: sql<number>`count(*)::int`,
      actionable_unread: sql<number>`(count(*) filter (where ${cliNotificationInbox.actionable}))::int`,
    })
    .from(cliNotificationInbox)
    .leftJoin(cliNotificationInboxReads, readJoin(userId))
    .where(
      and(eq(cliNotificationInbox.tenant_id, tenantId), isNull(cliNotificationInboxReads.inbox_id)),
    );
  const row = rows[0];
  return { unread: row?.unread ?? 0, actionable_unread: row?.actionable_unread ?? 0 };
}

export async function listInbox(
  db: Db,
  tenantId: string,
  userId: string | null,
  input: InboxListInput,
): Promise<InboxPage> {
  const tenantWhereClauses = [
    eq(cliNotificationInbox.tenant_id, tenantId),
    gt(cliNotificationInbox.id, input.since),
  ];
  if (input.unread_only) tenantWhereClauses.push(isNull(cliNotificationInboxReads.inbox_id));
  if (input.actionable_only) tenantWhereClauses.push(eq(cliNotificationInbox.actionable, true));

  const rows = await db
    .select({
      id: cliNotificationInbox.id,
      severity: cliNotificationInbox.severity,
      event_type: cliNotificationInbox.event_type,
      event_payload: cliNotificationInbox.event_payload,
      actionable: cliNotificationInbox.actionable,
      resource_type: cliNotificationInbox.resource_type,
      resource_id: cliNotificationInbox.resource_id,
      created_at: cliNotificationInbox.created_at,
      read_at: cliNotificationInboxReads.read_at,
    })
    .from(cliNotificationInbox)
    .leftJoin(cliNotificationInboxReads, readJoin(userId))
    .where(and(...tenantWhereClauses))
    .orderBy(asc(cliNotificationInbox.id))
    .limit(input.limit);

  const counts = await unreadCounts(db, tenantId, userId);
  return { rows, unread: counts.unread, actionable_unread: counts.actionable_unread };
}

export async function ackInbox(
  db: Db,
  actor: NotificationActor,
  userId: string,
  upToCursor: number,
): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO ${cliNotificationInboxReads} (tenant_id, inbox_id, user_id)
    SELECT ${cliNotificationInbox.tenant_id}, ${cliNotificationInbox.id}, ${userId}::uuid
    FROM ${cliNotificationInbox}
    WHERE ${cliNotificationInbox.tenant_id} = ${actor.tenant_id}
      AND ${cliNotificationInbox.id} <= ${upToCursor}
    ON CONFLICT (inbox_id, user_id) DO NOTHING
    RETURNING inbox_id
  `);
  const acked = result.rows.length;
  await auditAwait(
    {
      ...auditedBy(actor),
      action: AuditAction.SK_CLI_INBOX_ACKED,
      resource_type: "cli_notification_inbox",
      resource_id: String(upToCursor),
      result: "success",
      metadata: { up_to_cursor: upToCursor, marked: acked },
    },
    db,
  );
  return acked;
}

export async function markInboxRead(
  db: Db,
  tenantId: string,
  userId: string,
  ids: number[],
): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO ${cliNotificationInboxReads} (tenant_id, inbox_id, user_id)
    SELECT ${cliNotificationInbox.tenant_id}, ${cliNotificationInbox.id}, ${userId}::uuid
    FROM ${cliNotificationInbox}
    WHERE ${cliNotificationInbox.tenant_id} = ${tenantId}
      AND ${cliNotificationInbox.id} IN ${ids}
    ON CONFLICT (inbox_id, user_id) DO NOTHING
    RETURNING inbox_id
  `);
  return result.rows.length;
}

export async function markInboxUnread(
  db: Db,
  tenantId: string,
  userId: string,
  ids: number[],
): Promise<number> {
  const removed = await db
    .delete(cliNotificationInboxReads)
    .where(
      and(
        eq(cliNotificationInboxReads.tenant_id, tenantId),
        eq(cliNotificationInboxReads.user_id, userId),
        inArray(cliNotificationInboxReads.inbox_id, ids),
      ),
    )
    .returning({ inbox_id: cliNotificationInboxReads.inbox_id });
  return removed.length;
}
