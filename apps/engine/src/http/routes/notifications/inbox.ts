// sk CLI notification inbox — REST surface.
//
//   GET  /v1/notifications/inbox?since=&limit=   (pull window)
//   POST /v1/notifications/inbox/ack             (consume up to cursor)
//
// The CLI polls the inbox with a monotonic `since` cursor (last seen
// `id`), renders the returned items, then acknowledges them by posting
// the highest consumed `id` to `/ack`, which DELETEs the row window.
// Both routes are gated `notification:read` and scoped to the
// principal's tenant on every query.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, eq, gt, lte } from "drizzle-orm";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import { cliNotificationInbox } from "../../../db/schema/notifications.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

const INBOX_MAX_LIMIT = 500;

const InboxItemSchema = z
  .object({
    id: z.number(),
    severity: z.string(),
    event_type: z.string(),
    event_payload: z.unknown().nullable(),
    created_at: z.string(),
  })
  .openapi("CliNotificationInboxItem");

const InboxListResponse = z
  .object({
    items: z.array(InboxItemSchema),
    cursor: z.number(),
  })
  .openapi("CliNotificationInboxListResponse");

const InboxQuery = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(INBOX_MAX_LIMIT).optional(),
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

const listRoute = createRoute({
  method: "get",
  path: "/v1/notifications/inbox",
  tags: ["notifications"],
  summary: "Pull pending sk CLI inbox notifications",
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
  summary: "Acknowledge (consume) sk CLI inbox notifications up to a cursor",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: AckBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: AckResponse } },
    },
  },
});

export function registerInboxRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/notifications/inbox", requirePermission("notification:read"));
  app.use("/v1/notifications/inbox/ack", requirePermission("notification:read"));

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const since = q.since ?? 0;
    const limit = Math.min(q.limit ?? 100, INBOX_MAX_LIMIT);
    const rows = await db
      .select()
      .from(cliNotificationInbox)
      .where(
        and(
          eq(cliNotificationInbox.tenant_id, principal.tenant_id),
          gt(cliNotificationInbox.id, since),
        ),
      )
      .orderBy(asc(cliNotificationInbox.id))
      .limit(limit);
    const cursor = rows.length > 0 ? (rows[rows.length - 1]?.id ?? since) : since;
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          severity: r.severity,
          event_type: r.event_type,
          event_payload: r.event_payload ?? null,
          created_at: r.created_at.toISOString(),
        })),
        cursor,
      },
      200,
    );
  });

  app.openapi(ackRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { up_to_cursor } = c.req.valid("json");
    const deleted = await db
      .delete(cliNotificationInbox)
      .where(
        and(
          eq(cliNotificationInbox.tenant_id, principal.tenant_id),
          lte(cliNotificationInbox.id, up_to_cursor),
        ),
      )
      .returning({ id: cliNotificationInbox.id });
    const acked = deleted.length;
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.SK_CLI_INBOX_ACKED,
        resource_type: "cli_notification_inbox",
        resource_id: String(up_to_cursor),
        result: "success",
        metadata: { up_to_cursor, acked },
      },
      db,
    );
    return c.json({ acked }, 200);
  });
}
