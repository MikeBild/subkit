// Notification task inbox — REST surface.
//
//   GET  /v1/notifications/inbox?since=&limit=&unread_only=&actionable_only=
//   POST /v1/notifications/inbox/ack     (mark read up to a cursor)
//   POST /v1/notifications/inbox/read    (mark specific ids read)
//   POST /v1/notifications/inbox/unread  (undo a read mark)
//
// A row is a task, not a log line. Consumption is a per-user read mark
// in `cli_notification_inbox_reads`; no route here deletes an inbox row
// (the scheduler's retention sweep is the only DELETE). `/ack` keeps its
// path, body and `{acked}` response so an already-released `sk` binary
// works unchanged.
//
// All four routes stay on `notification:read`. A personal read marker is
// view state about the caller's own eyes, not tenant configuration —
// `notification:write` is scoped to notification *rules*, and requiring
// it would lock ordinary members out of dismissing their own items.
// Every query is scoped to the principal's tenant.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import type { Db } from "../../../db/client.ts";
import {
  cliNotificationInbox,
  cliNotificationInboxReads,
} from "../../../db/schema/notifications.ts";
import { HttpError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

const INBOX_MAX_LIMIT = 500;
const MARK_MAX_IDS = 500;

const InboxItemSchema = z
  .object({
    id: z.number(),
    severity: z.string(),
    event_type: z.string(),
    event_payload: z.unknown().nullable(),
    actionable: z.boolean(),
    resource_type: z.string().nullable(),
    resource_id: z.string().nullable(),
    read: z.boolean(),
    read_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("CliNotificationInboxItem");

const InboxListResponse = z
  .object({
    items: z.array(InboxItemSchema),
    cursor: z.number(),
    unread_count: z.number().int().nonnegative(),
    actionable_unread_count: z.number().int().nonnegative(),
  })
  .openapi("CliNotificationInboxListResponse");

const BoolQuery = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional();

const InboxQuery = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(INBOX_MAX_LIMIT).optional(),
  unread_only: BoolQuery,
  actionable_only: BoolQuery,
});

const AckBody = z
  .object({
    up_to_cursor: z.number().int().nonnegative(),
  })
  .openapi("CliNotificationInboxAckRequest");

const AckResponse = z
  .object({
    acked: z.number().int().nonnegative(),
  })
  .openapi("CliNotificationInboxAckResponse");

const IdsBody = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).max(MARK_MAX_IDS),
  })
  .openapi("CliNotificationInboxIdsRequest");

const MarkReadResponse = z
  .object({ marked: z.number().int().nonnegative() })
  .openapi("CliNotificationInboxMarkReadResponse");

const MarkUnreadResponse = z
  .object({ unmarked: z.number().int().nonnegative() })
  .openapi("CliNotificationInboxMarkUnreadResponse");

const listRoute = createRoute({
  method: "get",
  path: "/v1/notifications/inbox",
  tags: ["notifications"],
  summary: "List inbox tasks with this caller's read state",
  security: [{ bearerAuth: [] }],
  request: { query: InboxQuery },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: InboxListResponse } },
    },
  },
});

const ackRoute = createRoute({
  method: "post",
  path: "/v1/notifications/inbox/ack",
  tags: ["notifications"],
  summary: "Mark this caller's inbox tasks read up to a cursor",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: AckBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: AckResponse } },
    },
    400: {
      description: "Principal is not a user",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const readRoute = createRoute({
  method: "post",
  path: "/v1/notifications/inbox/read",
  tags: ["notifications"],
  summary: "Mark specific inbox tasks read for this caller",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: IdsBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: MarkReadResponse } },
    },
    400: {
      description: "Principal is not a user",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const unreadRoute = createRoute({
  method: "post",
  path: "/v1/notifications/inbox/unread",
  tags: ["notifications"],
  summary: "Restore unread state on specific inbox tasks for this caller",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: IdsBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: MarkUnreadResponse } },
    },
    400: {
      description: "Principal is not a user",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

/**
 * The read-state owner for this request, or null when the principal has
 * no `users.id`. An API key bound to a system account resolves to
 * `kind: "system_account"` with an id from `system_accounts` — that id
 * must never enter the `user_id` FK column.
 */
function readerId(principal: { kind: string; id: string }): string | null {
  return principal.kind === "user" ? principal.id : null;
}

function requireReader(principal: { kind: string; id: string }): string {
  const uid = readerId(principal);
  if (!uid) {
    throw new HttpError(
      400,
      "principal_not_user",
      "read state is per user; this principal is a system account and has no inbox of its own",
    );
  }
  return uid;
}

/** Join predicate for this caller's read marks; `false` when there is no caller user. */
function readJoin(userId: string | null) {
  return userId
    ? and(
        eq(cliNotificationInboxReads.inbox_id, cliNotificationInbox.id),
        eq(cliNotificationInboxReads.user_id, userId),
      )
    : sql`false`;
}

/** Unread totals over the caller's whole tenant inbox — independent of `since`/`limit`/filters. */
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

export function registerInboxRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/notifications/inbox", requirePermission("notification:read"));
  app.use("/v1/notifications/inbox/ack", requirePermission("notification:read"));
  app.use("/v1/notifications/inbox/read", requirePermission("notification:read"));
  app.use("/v1/notifications/inbox/unread", requirePermission("notification:read"));

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const since = q.since ?? 0;
    const limit = Math.min(q.limit ?? 100, INBOX_MAX_LIMIT);
    const userId = readerId(principal);

    const tenantWhereClauses = [
      eq(cliNotificationInbox.tenant_id, principal.tenant_id),
      gt(cliNotificationInbox.id, since),
    ];
    if (q.unread_only) tenantWhereClauses.push(isNull(cliNotificationInboxReads.inbox_id));
    if (q.actionable_only) tenantWhereClauses.push(eq(cliNotificationInbox.actionable, true));

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
      .limit(limit);

    const counts = await unreadCounts(db, principal.tenant_id, userId);
    const cursor = rows.length > 0 ? (rows[rows.length - 1]?.id ?? since) : since;
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          severity: r.severity,
          event_type: r.event_type,
          event_payload: r.event_payload ?? null,
          actionable: r.actionable,
          resource_type: r.resource_type,
          resource_id: r.resource_id,
          read: r.read_at !== null,
          read_at: r.read_at?.toISOString() ?? null,
          created_at: r.created_at.toISOString(),
        })),
        cursor,
        unread_count: counts.unread,
        actionable_unread_count: counts.actionable_unread,
      },
      200,
    );
  });

  app.openapi(ackRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { up_to_cursor } = c.req.valid("json");
    const userId = requireReader(principal);

    // One statement: `ON CONFLICT DO NOTHING` makes the rowcount exactly
    // the rows that were still unread for this caller, with no read-then-
    // write race against a concurrent ack.
    const result = await db.execute(sql`
      INSERT INTO ${cliNotificationInboxReads} (tenant_id, inbox_id, user_id)
      SELECT ${cliNotificationInbox.tenant_id}, ${cliNotificationInbox.id}, ${userId}::uuid
      FROM ${cliNotificationInbox}
      WHERE ${cliNotificationInbox.tenant_id} = ${principal.tenant_id}
        AND ${cliNotificationInbox.id} <= ${up_to_cursor}
      ON CONFLICT (inbox_id, user_id) DO NOTHING
      RETURNING inbox_id
    `);
    const acked = result.rows.length;

    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.SK_CLI_INBOX_ACKED,
        resource_type: "cli_notification_inbox",
        resource_id: String(up_to_cursor),
        result: "success",
        metadata: { up_to_cursor, marked: acked },
      },
      db,
    );
    return c.json({ acked }, 200);
  });

  // `/read` and `/unread` write no audit row on purpose: they fire once
  // per rendered notification, so auditing them would put one `audit_log`
  // row behind every item a client paints. `/ack` still records the
  // watermark, which is the operator-meaningful event.
  app.openapi(readRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { ids } = c.req.valid("json");
    const userId = requireReader(principal);

    const result = await db.execute(sql`
      INSERT INTO ${cliNotificationInboxReads} (tenant_id, inbox_id, user_id)
      SELECT ${cliNotificationInbox.tenant_id}, ${cliNotificationInbox.id}, ${userId}::uuid
      FROM ${cliNotificationInbox}
      WHERE ${cliNotificationInbox.tenant_id} = ${principal.tenant_id}
        AND ${cliNotificationInbox.id} IN ${ids}
      ON CONFLICT (inbox_id, user_id) DO NOTHING
      RETURNING inbox_id
    `);
    return c.json({ marked: result.rows.length }, 200);
  });

  app.openapi(unreadRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { ids } = c.req.valid("json");
    const userId = requireReader(principal);

    const removed = await db
      .delete(cliNotificationInboxReads)
      .where(
        and(
          eq(cliNotificationInboxReads.tenant_id, principal.tenant_id),
          eq(cliNotificationInboxReads.user_id, userId),
          inArray(cliNotificationInboxReads.inbox_id, ids),
        ),
      )
      .returning({ inbox_id: cliNotificationInboxReads.inbox_id });
    return c.json({ unmarked: removed.length }, 200);
  });
}
